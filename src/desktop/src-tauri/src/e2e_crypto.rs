//! B5: 桌面端端到端加密（E2E）密钥库与加解密命令。
//!
//! 协议契约：`docs/plans/e2e-protocol.md`（唯一实现契约，本文件与其冲突时以协议为准）。
//! 测试向量：`docs/plans/e2e-vector.json`（见底部 `#[cfg(test)]` 对拍用例）。
//!
//! 算法栈（协议 §1）：
//!   设备身份密钥：ECDH P-256（secp256r1），公钥 = 65B 未压缩点（0x04 || X || Y）的 base64；
//!   内容加密：AES-256-GCM，随机 32B 内容密钥 K + 随机 12B IV；
//!   密钥封装：ECDH(发送方临时私钥, 接收方静态公钥) → HKDF-SHA256
//!     （salt = "clipsync-e2e-v1"，info = 接收方 deviceId 的 UTF-8 字节，输出 32B KEK），
//!     再用 KEK 以 AES-256-GCM（独立随机 12B 包装 IV）包装 K → 48B wrappedKey。
//!   每次加密生成新的临时 P-256 密钥对，epk 随信封下发。
//!
//! 密钥存储（协议 §4）：Tauri `app_data_dir` 下 `e2e-key.pem`，内容为 JSON
//! `{ private_key: <b64 32B>, public_key: <b64 65B> }`（public_key 为冗余展示字段，
//! 永不作为信任来源，运行时始终由 private_key 重新派生）。
//!   - unix：文件权限收紧到 0600；
//!   - Windows：无 POSIX 0600 等价物。文件位于 %APPDATA%\com.clipsync.desktop\（用户
//!     profile 目录），默认 ACL 继承自用户 profile，仅当前用户与 SYSTEM/Administrators
//!     可访问；未引入 DPAPI/ACL 额外依赖。如需更强保护，v2 可用 DPAPI 加密私钥文件。
//!
//! 惰性加载：命令首次调用时从磁盘加载密钥对；文件缺失时仅 `e2e_ensure_keypair` /
//! `e2e_decrypt` 会生成并持久化新密钥（`e2e_status` / `e2e_public_key` 为只读，不产生
//! 副作用）。密钥文件存在但损坏时返回 Err 而不是静默重新生成 —— 重新生成会让该设备
//! 永久解不开历史 E2E 条目，必须显式暴露失败。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use hkdf::Hkdf;
use p256::ecdh::diffie_hellman;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::Manager;

// ============================================================================
// 协议常量
// ============================================================================

/// HKDF salt（协议 §1，ASCII）
pub const HKDF_SALT: &[u8] = b"clipsync-e2e-v1";
/// 信封 alg 字段（协议 §2）
pub const ENVELOPE_ALG: &str = "ECDH-P256+HKDF-SHA256+A256GCM";
/// 信封版本（协议 §2）
pub const ENVELOPE_VERSION: u8 = 1;
/// 私钥文件名（协议 §4：app-data 目录 `e2e-key.pem`）
const KEY_FILE_NAME: &str = "e2e-key.pem";
/// P-256 未压缩公钥长度（0x04 || X || Y）
const P256_UNCOMPRESSED_LEN: usize = 65;
/// AES-GCM IV 长度（96-bit）
const GCM_IV_LEN: usize = 12;
/// 内容密钥 K / KEK 长度（AES-256）
const KEY_LEN: usize = 32;
/// 服务端限制：metadata.e2e.keys ≤ 32 项（协议 §5）
const MAX_RECIPIENTS: usize = 32;

// ============================================================================
// 状态与数据结构
// ============================================================================

/// E2E 模块全局状态：本机静态私钥（永不出 Rust 进程）。
/// 通过 `.manage()` 挂载，命令内以 `tauri::State` 访问。
pub struct E2eState {
    keypair: Mutex<Option<SecretKey>>,
}

impl E2eState {
    pub fn new() -> Self {
        Self {
            keypair: Mutex::new(None),
        }
    }

    fn get(&self) -> Option<SecretKey> {
        self.keypair
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set(&self, sk: SecretKey) {
        *self
            .keypair
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sk);
    }
}

impl Default for E2eState {
    fn default() -> Self {
        Self::new()
    }
}

/// 加密接收方。字段名对前端使用 camelCase（invoke 时传 `{ deviceId, publicKey }`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eRecipient {
    pub device_id: String,
    pub public_key: String,
}

// ============================================================================
// 基础原语：base64 / 随机数 / AES-256-GCM / ECDH+HKDF
// ============================================================================

fn b64<T: AsRef<[u8]>>(data: T) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn unb64(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("e2e: base64 解码失败: {e}"))
}

fn random_array<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    OsRng.fill_bytes(&mut buf);
    buf
}

/// AES-256-GCM 加密，返回 ciphertext || tag(16B)。
fn aes_gcm_seal(key: &[u8; KEY_LEN], iv: &[u8; GCM_IV_LEN], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("e2e: AES 密钥初始化失败: {e}"))?;
    cipher
        .encrypt(Nonce::from_slice(iv), plaintext)
        .map_err(|_| "e2e: AES-GCM 加密失败".to_string())
}

/// AES-256-GCM 解密（tag 校验失败即整体失败）。
fn aes_gcm_open(key: &[u8; KEY_LEN], iv: &[u8; GCM_IV_LEN], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("e2e: AES 密钥初始化失败: {e}"))?;
    cipher
        .decrypt(Nonce::from_slice(iv), ciphertext)
        .map_err(|_| "e2e: AES-GCM 解密失败（密文被篡改或密钥不匹配）".to_string())
}

/// ECDH(eph_priv, peer_pub) → HKDF-SHA256(salt="clipsync-e2e-v1", info=deviceId) → 32B KEK。
/// 加密方向：eph_priv = 发送方临时私钥，peer_pub = 接收方静态公钥；
/// 解密方向：eph_priv = 本机静态私钥，peer_pub = 信封 epk（ECDH 对称，共享点相同）。
fn derive_kek(eph_priv: &SecretKey, peer_pub: &PublicKey, device_id: &str) -> Result<[u8; KEY_LEN], String> {
    // elliptic-curve 0.13.8 的 diffie_hellman 接收标量与仿射点
    let shared = diffie_hellman(eph_priv.to_nonzero_scalar(), peer_pub.as_affine());
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), shared.raw_secret_bytes());
    let mut kek = [0u8; KEY_LEN];
    hk.expand(device_id.as_bytes(), &mut kek)
        .map_err(|e| format!("e2e: HKDF expand 失败: {e}"))?;
    Ok(kek)
}

/// 解析并校验 P-256 公钥：base64 → 必须 65B 且 0x04 开头（未压缩点）。
fn parse_public_key(public_key_b64: &str) -> Result<PublicKey, String> {
    let bytes = unb64(public_key_b64)?;
    if bytes.len() != P256_UNCOMPRESSED_LEN {
        return Err(format!(
            "e2e: 公钥必须为 {P256_UNCOMPRESSED_LEN} 字节未压缩点，实际 {} 字节",
            bytes.len()
        ));
    }
    if bytes[0] != 0x04 {
        return Err("e2e: 公钥必须以 0x04 开头（未压缩点格式）".to_string());
    }
    PublicKey::from_sec1_bytes(&bytes).map_err(|e| format!("e2e: 非法 P-256 公钥: {e}"))
}

fn public_key_b64(pk: &PublicKey) -> String {
    b64(pk.to_encoded_point(false).as_bytes())
}

fn secret_public_key_b64(sk: &SecretKey) -> String {
    public_key_b64(&sk.public_key())
}

// ============================================================================
// 密钥持久化（app_data_dir / e2e-key.pem）
// ============================================================================

#[derive(Serialize, Deserialize)]
struct E2eKeyFile {
    /// 32B 标量，base64
    private_key: String,
    /// 65B 未压缩点，base64。冗余存储字段，仅作展示；一致性校验失败时以 private_key 为准。
    #[serde(default)]
    public_key: Option<String>,
}

fn key_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(KEY_FILE_NAME))
        .map_err(|e| format!("e2e: 无法获取 app_data_dir: {e}"))
}

/// 从磁盘加载私钥。文件不存在 → Ok(None)；存在但损坏/非法 → Err（不静默重生，
/// 否则该设备将永久解不开历史 E2E 条目）。
fn load_keypair_from_disk(app: &tauri::AppHandle) -> Result<Option<SecretKey>, String> {
    let path = key_file_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("e2e: 无法读取密钥文件 {}: {e}", path.display()))?;
    let parsed: E2eKeyFile = serde_json::from_str(&raw)
        .map_err(|e| format!("e2e: 密钥文件 {} 已损坏（拒绝静默重新生成）: {e}", path.display()))?;
    let bytes = unb64(&parsed.private_key)?;
    let sk = SecretKey::from_slice(&bytes)
        .map_err(|e| format!("e2e: 密钥文件中的私钥非法: {e}"))?;
    if let Some(stored_pub) = &parsed.public_key {
        if let Ok(stored) = parse_public_key(stored_pub) {
            if public_key_b64(&stored) != secret_public_key_b64(&sk) {
                log::warn!("[E2E] 密钥文件中的 public_key 与 private_key 不一致，以 private_key 派生值为准");
            }
        }
    }
    Ok(Some(sk))
}

/// 持久化密钥对。unix 上收紧为 0600；Windows 见模块头注释（用户 profile 目录默认 ACL）。
fn persist_keypair(app: &tauri::AppHandle, sk: &SecretKey) -> Result<(), String> {
    let path = key_file_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("e2e: 无法创建数据目录 {}: {e}", dir.display()))?;
    }
    let file = E2eKeyFile {
        private_key: b64(sk.to_bytes()),
        public_key: Some(secret_public_key_b64(sk)),
    };
    let raw = serde_json::to_string_pretty(&file).map_err(|e| format!("e2e: 序列化密钥失败: {e}"))?;
    // 先写临时文件再 rename，避免半写状态损坏密钥文件
    let tmp = path.with_extension("pem.tmp");
    std::fs::write(&tmp, &raw)
        .map_err(|e| format!("e2e: 无法写入密钥文件 {}: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)) {
            log::warn!("[E2E] 无法收紧临时密钥文件权限: {e}");
        }
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("e2e: 无法落盘密钥文件 {}: {e}", path.display())
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
            log::warn!("[E2E] 无法收紧密钥文件权限到 0600: {e}");
        }
    }
    log::info!("[E2E] 静态密钥对已写入 {}", path.display());
    Ok(())
}

/// 只读加载：内存有则直接返回；否则尝试磁盘；磁盘也没有 → Ok(None)（不生成）。
/// 供 e2e_status / e2e_public_key 使用。
fn load_if_present(app: &tauri::AppHandle, state: &E2eState) -> Result<Option<SecretKey>, String> {
    if let Some(sk) = state.get() {
        return Ok(Some(sk));
    }
    match load_keypair_from_disk(app)? {
        Some(sk) => {
            state.set(sk.clone());
            Ok(Some(sk))
        }
        None => Ok(None),
    }
}

/// ensure 语义：内存 → 磁盘 → 生成并持久化。供 e2e_ensure_keypair / e2e_decrypt 使用。
fn load_or_create(app: &tauri::AppHandle, state: &E2eState) -> Result<SecretKey, String> {
    if let Some(sk) = state.get() {
        return Ok(sk);
    }
    if let Some(sk) = load_keypair_from_disk(app)? {
        state.set(sk.clone());
        return Ok(sk);
    }
    let sk = SecretKey::random(&mut OsRng);
    persist_keypair(app, &sk)?;
    state.set(sk.clone());
    Ok(sk)
}

// ============================================================================
// 核心加解密（纯函数，供命令与单元测试复用）
// ============================================================================

/// 加密（协议 §3 发送流程）：
/// 1. 生成随机 32B 内容密钥 K + 12B 内容 IV，ciphertext = AES-256-GCM(K, iv, plaintext)；
/// 2. 生成一次性临时 P-256 密钥对；
/// 3. 对每个接收方：KEK = HKDF(ECDH(ephPriv, pub_d), salt, info=deviceId)，
///    keys[d] = { w: AES-GCM(KEK, wiv, K)（48B）, iv: wiv }。
///
/// 返回值 = 完整信封 + `ciphertext` 字段。上传时应把 `ciphertext`（即
/// base64(ciphertext || tag)）放进 content_encrypted 列，metadata.e2e 只保留
/// v/alg/epk/iv/keys（协议 §2）；`keys` 是否包含发送设备自身由调用方决定（协议要求包含）。
pub(crate) fn e2e_encrypt_core(
    content_b64: &str,
    recipients: &[E2eRecipient],
) -> Result<serde_json::Value, String> {
    if recipients.is_empty() {
        return Err("e2e: recipients 为空（至少需要 1 个接收设备；按协议发送方也应把自己加入 keys）".to_string());
    }
    if recipients.len() > MAX_RECIPIENTS {
        return Err(format!("e2e: recipients 数量超过服务端上限 {MAX_RECIPIENTS}"));
    }

    let plaintext = unb64(content_b64)?;
    let content_key: [u8; KEY_LEN] = random_array();
    let content_iv: [u8; GCM_IV_LEN] = random_array();
    let ciphertext = aes_gcm_seal(&content_key, &content_iv, &plaintext)?;

    // 每次加密生成新的临时 P-256 密钥对（epk 随信封走）
    let eph = SecretKey::random(&mut OsRng);
    let epk_b64 = secret_public_key_b64(&eph);

    let mut keys: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for r in recipients {
        let device_id = r.device_id.trim();
        if device_id.is_empty() {
            return Err("e2e: recipient.deviceId 不能为空".to_string());
        }
        let pk = parse_public_key(&r.public_key)?;
        let kek = derive_kek(&eph, &pk, device_id)?;
        let wiv: [u8; GCM_IV_LEN] = random_array();
        let wrapped = aes_gcm_seal(&kek, &wiv, &content_key)?; // 32B K + 16B tag = 48B
        keys.insert(
            device_id.to_string(),
            serde_json::json!({ "w": b64(&wrapped), "iv": b64(wiv) }),
        );
    }

    Ok(serde_json::json!({
        "v": ENVELOPE_VERSION,
        "alg": ENVELOPE_ALG,
        "epk": epk_b64,
        "iv": b64(content_iv),
        "keys": keys,
        "ciphertext": b64(&ciphertext),
    }))
}

/// 解密（协议 §3 接收流程）：ECDH(myPriv, epk) → HKDF(info=本机 deviceId) → 解包 K →
/// AES-GCM 解密 ciphertext。返回明文的 base64。
///
/// `envelope` 字段要求：epk / iv / keys（{ deviceId: { w, iv } }）必填；密文从
/// `ciphertext`、`ciphertextB64`（e2e-vector.json 的写法）或 `content_encrypted`
/// （协议列名）三者之一读取 —— 兼容测试向量与 B6/B7 的 metadata.e2e + content_encrypted
/// 合并对象两种形态。
pub(crate) fn e2e_decrypt_core(
    private_key: &SecretKey,
    envelope: &serde_json::Value,
    device_id: &str,
) -> Result<String, String> {
    let device_id = device_id.trim();
    if device_id.is_empty() {
        return Err("e2e: device_id 不能为空".to_string());
    }

    let epk_b64 = envelope
        .get("epk")
        .and_then(|v| v.as_str())
        .ok_or("e2e: 信封缺少 epk")?;
    let iv_b64 = envelope
        .get("iv")
        .and_then(|v| v.as_str())
        .ok_or("e2e: 信封缺少 iv")?;
    let keys = envelope
        .get("keys")
        .and_then(|v| v.as_object())
        .ok_or("e2e: 信封缺少 keys")?;
    let ct_b64 = ["ciphertext", "ciphertextB64", "content_encrypted"]
        .iter()
        .find_map(|k| envelope.get(*k).and_then(|v| v.as_str()))
        .ok_or("e2e: 信封缺少密文字段（ciphertext / ciphertextB64 / content_encrypted 三者之一）")?;

    let entry = keys
        .get(device_id)
        .ok_or_else(|| format!("e2e: 本设备 ({device_id}) 不在信封 keys 列表中"))?;
    let w_b64 = entry
        .get("w")
        .and_then(|v| v.as_str())
        .ok_or("e2e: keys 条目缺少 w")?;
    let wiv_b64 = entry
        .get("iv")
        .and_then(|v| v.as_str())
        .ok_or("e2e: keys 条目缺少 iv")?;

    let epk_bytes = unb64(epk_b64)?;
    if epk_bytes.len() != P256_UNCOMPRESSED_LEN || epk_bytes[0] != 0x04 {
        return Err("e2e: 信封 epk 非法（必须 65B 且 0x04 开头）".to_string());
    }
    let epk = PublicKey::from_sec1_bytes(&epk_bytes)
        .map_err(|e| format!("e2e: 信封 epk 非法: {e}"))?;

    // ECDH(myPriv, epk) → HKDF(salt, info=本机 deviceId) → KEK → 解包 K
    let kek = derive_kek(private_key, &epk, device_id)?;
    let wrapped = unb64(w_b64)?;
    let wiv_bytes = unb64(wiv_b64)?;
    if wiv_bytes.len() != GCM_IV_LEN {
        return Err(format!("e2e: 包装 IV 长度非法: {}（应为 {GCM_IV_LEN}）", wiv_bytes.len()));
    }
    let mut wiv = [0u8; GCM_IV_LEN];
    wiv.copy_from_slice(&wiv_bytes);
    let content_key_bytes = aes_gcm_open(&kek, &wiv, &wrapped)?;
    if content_key_bytes.len() != KEY_LEN {
        return Err(format!(
            "e2e: 解包出的内容密钥长度非法: {}（应为 {KEY_LEN}）",
            content_key_bytes.len()
        ));
    }
    let mut content_key = [0u8; KEY_LEN];
    content_key.copy_from_slice(&content_key_bytes);

    let iv_bytes = unb64(iv_b64)?;
    if iv_bytes.len() != GCM_IV_LEN {
        return Err(format!("e2e: 内容 IV 长度非法: {}（应为 {GCM_IV_LEN}）", iv_bytes.len()));
    }
    let mut iv = [0u8; GCM_IV_LEN];
    iv.copy_from_slice(&iv_bytes);

    let ct = unb64(ct_b64)?;
    let plaintext = aes_gcm_open(&content_key, &iv, &ct)?;
    Ok(b64(plaintext))
}

// ============================================================================
// Tauri commands
// ============================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eStatus {
    pub has_keypair: bool,
    pub public_key: Option<String>,
}

/// 查询本机 E2E 密钥对状态（只读，不会触发密钥生成）。
#[tauri::command]
pub fn e2e_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, E2eState>,
) -> Result<E2eStatus, String> {
    let sk = load_if_present(&app, &state)?;
    Ok(match sk {
        Some(sk) => E2eStatus {
            has_keypair: true,
            public_key: Some(secret_public_key_b64(&sk)),
        },
        None => E2eStatus {
            has_keypair: false,
            public_key: None,
        },
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eEnsureKeypairResult {
    pub public_key: String,
}

/// 确保本机存在 E2E 静态密钥对：无则生成并持久化到 app_data_dir/e2e-key.pem，有则直接返回。
#[tauri::command]
pub fn e2e_ensure_keypair(
    app: tauri::AppHandle,
    state: tauri::State<'_, E2eState>,
) -> Result<E2eEnsureKeypairResult, String> {
    let sk = load_or_create(&app, &state)?;
    Ok(E2eEnsureKeypairResult {
        public_key: secret_public_key_b64(&sk),
    })
}

/// 返回本机 E2E 公钥（65B 未压缩点 base64）；无密钥对时返回 None（不触发生成）。
#[tauri::command]
pub fn e2e_public_key(
    app: tauri::AppHandle,
    state: tauri::State<'_, E2eState>,
) -> Result<Option<String>, String> {
    Ok(load_if_present(&app, &state)?.map(|sk| secret_public_key_b64(&sk)))
}

/// 加密内容（content_b64 = 明文字节的 base64，文本或二进制均可）。
/// 加密只用一次性临时密钥对 + 接收方公钥，不依赖本机静态密钥。
/// 按协议，调用方应把本设备也放进 recipients（keys 需包含发送方自己）。
#[tauri::command]
pub fn e2e_encrypt(content_b64: String, recipients: Vec<E2eRecipient>) -> Result<serde_json::Value, String> {
    e2e_encrypt_core(&content_b64, &recipients)
}

/// 解密信封。返回明文的 base64；本设备无对应 wrapped key、或任何一步解密失败 → Err。
#[tauri::command]
pub fn e2e_decrypt(
    app: tauri::AppHandle,
    state: tauri::State<'_, E2eState>,
    envelope: serde_json::Value,
    device_id: String,
) -> Result<String, String> {
    let sk = load_or_create(&app, &state)?;
    e2e_decrypt_core(&sk, &envelope, &device_id)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // docs/plans/e2e-vector.json —— 标准测试向量（硬编码，防 include_str! 路径问题）
    const VEC_DEVICE_ID: &str = "11111111-2222-3333-4444-555555555555";
    const VEC_RECIPIENT_PRIV: &str = "pSdNimTX0ecVtVNpIvtdCHIOCbQFY3XN1PUE+VObiBY=";
    const VEC_RECIPIENT_PUB: &str = "BHaPJXJxZcrMOvnDkLRqTfjWYDKGDcv+yu65xzRJRqEFK4qtCAHoucSJ+mJ1phqGqo7uD7PU6Qkh495JQSl+rUI=";
    const VEC_CIPHERTEXT: &str = "NxZxfY970DsYNuzknxqiHaU5i/cQkqp6fS5OiM+oz6RhAVhDdYaYGncr6NwulCbzrJ4qcXSFy6Q=";
    const VEC_EPK: &str = "BP57SyNEf7gLfCgl/QD3QLfTDaEadnlF2jLuSWu0IrxojjZUYTL6fxiA9NQxeUNvpBmmX+DCweBLSoU2ztHP5/I=";
    const VEC_IV: &str = "40tdTI2ae5YdP6KI";
    const VEC_W: &str = "mvi3AKP+384KS7y19FCdHA0OgVwQ1s+5UaaCQXd42WyqBLa3xQJx2VHEVhZ+fZ28";
    const VEC_WIV: &str = "BlBKVeruduizXwe2";
    const VEC_EXPECTED: &str = "hello clipsync 端到端加密测试 ✨";

    fn fixture_keypair() -> SecretKey {
        SecretKey::from_slice(&unb64(VEC_RECIPIENT_PRIV).unwrap()).unwrap()
    }

    /// 向量对拍（协议 §8）：fixture 私钥 + 信封 epk → ECDH → HKDF(info=deviceId) →
    /// 解包 w → 得 K → AES-GCM 解 ciphertext → 明文必须等于 expectedPlaintext。
    #[test]
    fn vector_unwrap_and_decrypt() {
        let sk = fixture_keypair();

        // fixture 私钥派生出的公钥必须与 fixture 公钥一致（健全性检查）
        assert_eq!(secret_public_key_b64(&sk), VEC_RECIPIENT_PUB);

        // 用向量信封原文构造 JSON（ciphertext 用向量文件的字段名 ciphertextB64，
        // 同时覆盖 decrypt 的兼容字段解析路径）
        let envelope = serde_json::json!({
            "v": 1,
            "alg": ENVELOPE_ALG,
            "epk": VEC_EPK,
            "iv": VEC_IV,
            "keys": {
                (VEC_DEVICE_ID): { "w": VEC_W, "iv": VEC_WIV }
            },
            "ciphertextB64": VEC_CIPHERTEXT,
        });

        let pt_b64 = e2e_decrypt_core(&sk, &envelope, VEC_DEVICE_ID)
            .expect("标准测试向量解密失败");
        let plaintext = unb64(&pt_b64).unwrap();
        assert_eq!(
            String::from_utf8(plaintext).unwrap(),
            VEC_EXPECTED,
            "解密结果与 expectedPlaintext 不一致"
        );
    }

    /// 反向向量往返（协议 §8）：fixture 公钥作为接收方公钥加密 expectedPlaintext →
    /// fixture 私钥自解密 → 一致。同时校验信封结构（v/alg/epk 65B/w 48B）。
    #[test]
    fn vector_encrypt_roundtrip_with_fixture_keys() {
        let sk = fixture_keypair();
        let plaintext_b64 = b64(VEC_EXPECTED.as_bytes());

        let env = e2e_encrypt_core(
            &plaintext_b64,
            &[E2eRecipient {
                device_id: VEC_DEVICE_ID.to_string(),
                public_key: VEC_RECIPIENT_PUB.to_string(),
            }],
        )
        .expect("标准测试向量反向加密失败");

        assert_eq!(env["v"], 1);
        assert_eq!(env["alg"], ENVELOPE_ALG);
        let epk = unb64(env["epk"].as_str().unwrap()).unwrap();
        assert_eq!(epk.len(), P256_UNCOMPRESSED_LEN);
        assert_eq!(epk[0], 0x04);
        let w = unb64(env["keys"][VEC_DEVICE_ID]["w"].as_str().unwrap()).unwrap();
        assert_eq!(w.len(), 48, "wrappedKey 应为 32B K + 16B tag = 48B");
        let wiv = unb64(env["keys"][VEC_DEVICE_ID]["iv"].as_str().unwrap()).unwrap();
        assert_eq!(wiv.len(), GCM_IV_LEN);

        let pt_b64 = e2e_decrypt_core(&sk, &env, VEC_DEVICE_ID).expect("往返解密失败");
        assert_eq!(unb64(&pt_b64).unwrap(), VEC_EXPECTED.as_bytes());
    }

    /// 自往返（工单要求）：随机生成密钥对 → 加密 → 用同一密钥对解密 → 一致。
    /// 内容为任意二进制（含多字节 UTF-8 序列），验证 base64 边界无损。
    #[test]
    fn self_roundtrip_generated_keypair() {
        let sk = SecretKey::random(&mut OsRng);
        let pub_b64 = secret_public_key_b64(&sk);
        let content: &[u8] = b"clip content 123 \xf0\x9f\x94\x92 \xe4\xb8\xad\xe6\x96\x87";

        let env = e2e_encrypt_core(
            &b64(content),
            &[E2eRecipient {
                device_id: "self-device".to_string(),
                public_key: pub_b64,
            }],
        )
        .expect("encrypt failed");

        let pt_b64 = e2e_decrypt_core(&sk, &env, "self-device").expect("decrypt failed");
        assert_eq!(unb64(&pt_b64).unwrap(), content);
    }

    /// 接收方公钥非法（长度错误 / 非 0x04 开头 / 非法点）必须返回 Err。
    #[test]
    fn rejects_invalid_recipient_public_key() {
        let ok_content = b64(b"x");

        // 长度错误（64B）
        let err = e2e_encrypt_core(
            &ok_content,
            &[E2eRecipient {
                device_id: "d".to_string(),
                public_key: b64(vec![0x04u8; 64]),
            }],
        )
        .unwrap_err();
        assert!(err.contains("65"), "unexpected error: {err}");

        // 非 0x04 开头
        let err = e2e_encrypt_core(
            &ok_content,
            &[E2eRecipient {
                device_id: "d".to_string(),
                public_key: b64(vec![0x02u8; 65]),
            }],
        )
        .unwrap_err();
        assert!(err.contains("0x04"), "unexpected error: {err}");

        // 空 recipients
        assert!(e2e_encrypt_core(&ok_content, &[]).is_err());
    }

    /// 本设备不在 keys 列表 → Err（协议 §3 接收流程的占位语义由前端实现）。
    #[test]
    fn decrypt_errors_when_device_missing() {
        let sk = SecretKey::random(&mut OsRng);
        let other = SecretKey::random(&mut OsRng);
        let env = e2e_encrypt_core(
            &b64(b"secret"),
            &[E2eRecipient {
                device_id: "other-device".to_string(),
                public_key: secret_public_key_b64(&other),
            }],
        )
        .unwrap();
        let err = e2e_decrypt_core(&sk, &env, "not-in-keys").unwrap_err();
        assert!(err.contains("不在信封 keys"), "unexpected error: {err}");

        // 用了错误的私钥（在 keys 里但不是该设备对应的私钥）→ 解包 K 必失败
        let err = e2e_decrypt_core(&sk, &env, "other-device").unwrap_err();
        assert!(err.contains("解密失败"), "unexpected error: {err}");
    }

    /// 随机性健全性：两次加密同一段内容，信封（epk/iv/w/ciphertext）必须不同。
    #[test]
    fn encryption_is_nondeterministic() {
        let sk = SecretKey::random(&mut OsRng);
        let pub_b64 = secret_public_key_b64(&sk);
        let recipients = vec![E2eRecipient {
            device_id: "d".to_string(),
            public_key: pub_b64,
        }];
        let env1 = e2e_encrypt_core(&b64(b"same"), &recipients).unwrap();
        let env2 = e2e_encrypt_core(&b64(b"same"), &recipients).unwrap();
        assert_ne!(env1["epk"], env2["epk"]);
        assert_ne!(env1["iv"], env2["iv"]);
        assert_ne!(env1["ciphertext"], env2["ciphertext"]);
    }
}
