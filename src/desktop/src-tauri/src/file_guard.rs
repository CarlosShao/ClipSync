//! 文件路径访问闸口：所有接受前端传入路径的 IPC 命令必须经 `validate_path`。
//!
//! 允许集合 = ①「本机剪贴板捕获登记过的文件」（monitor / get_clipboard_files
//! 在捕获时调用 `register_paths` 登记，持久化到 app_data_dir，跨重启有效）
//! ② 应用自有目录（app_data_dir、%TEMP%\clipsync）。远端同步条目里的任意
//! 路径（攻击面）两者都不命中，直接拒绝。
use log::{debug, error, info};
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 登记文件名（位于 app_data_dir 下）
const REGISTRY_FILE_NAME: &str = "captured_paths.json";
/// 登记表上限：超出按最旧淘汰（正常用户远达不到；防无界增长）
const MAX_REGISTRY_ENTRIES: usize = 4096;

pub enum Reject {
    /// 路径不存在 / 无法解析（与「越权」分开报错，便于前端区分跨设备场景）
    NotFound,
    /// 存在但不在允许集合内。错误信息不回显请求路径，避免沦为任意路径探测器。
    Denied,
}

impl Reject {
    pub fn message(&self) -> &'static str {
        match self {
            Reject::NotFound => "File not found",
            Reject::Denied => "Path not allowed",
        }
    }
}

struct GuardState {
    roots: Vec<PathBuf>,
    /// 已登记路径的归一化 key（canonicalize + Windows 小写）
    registry: HashSet<String>,
    /// 与 registry 同步的插入序，用于淘汰
    order: VecDeque<String>,
    registry_file: Option<PathBuf>,
}

static STATE: Mutex<Option<GuardState>> = Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, Option<GuardState>> {
    // panic='abort' 下沿用 e2e_crypto 的 poison-safe 写法，锁中毒不追加崩溃点
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// 启动时初始化允许根目录并加载持久化登记表。必须在任何命令执行前调用。
pub fn init(app: &tauri::AppHandle) {
    use tauri::Manager;
    let mut roots = Vec::new();
    let data_dir = app.path().app_data_dir();
    match &data_dir {
        Ok(d) => roots.push(d.clone()),
        Err(e) => error!("[FileGuard] app_data_dir unavailable: {}", e),
    }
    // save_and_copy_file 的落盘目录（跨设备文件还原）
    roots.push(std::env::temp_dir().join("clipsync"));

    let registry_file = data_dir.ok().map(|d| d.join(REGISTRY_FILE_NAME));
    let (registry, order) = load_registry(registry_file.as_ref());
    info!("[FileGuard] initialized, {} captured path(s) on record", registry.len());

    *lock() = Some(GuardState {
        roots,
        registry,
        order,
        registry_file,
    });
}

fn load_registry(file: Option<&PathBuf>) -> (HashSet<String>, VecDeque<String>) {
    let mut registry = HashSet::new();
    let mut order = VecDeque::new();
    let Some(path) = file else {
        return (registry, order);
    };
    match std::fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<Vec<String>>(&raw) {
            Ok(keys) => {
                for k in keys {
                    if registry.insert(k.clone()) {
                        order.push_back(k);
                    }
                }
            }
            Err(e) => error!("[FileGuard] corrupt registry {}: {}", path.display(), e),
        },
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            error!("[FileGuard] cannot read registry {}: {}", path.display(), e)
        }
        Err(_) => {}
    }
    (registry, order)
}

fn persist_locked(st: &GuardState) {
    let Some(path) = &st.registry_file else { return };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            error!("[FileGuard] cannot create registry dir: {}", e);
            return;
        }
    }
    let keys: Vec<&String> = st.order.iter().collect();
    match serde_json::to_string(&keys) {
        Ok(raw) => {
            if let Err(e) = std::fs::write(path, raw) {
                error!("[FileGuard] cannot write registry: {}", e);
            }
        }
        Err(e) => error!("[FileGuard] cannot serialize registry: {}", e),
    }
}

/// Windows 下 canonicalize 产出 `\\?\` verbatim 前缀；路径 key 统一小写，
/// 因为 NTFS 大小写不敏感，登记表匹配必须忽略大小写。
fn norm_key(p: &Path) -> String {
    let s = p.to_string_lossy();
    #[cfg(windows)]
    {
        s.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        s.into_owned()
    }
}

/// 按路径分量比较 child 是否位于 root 之内。
/// 不能用字符串 starts_with：`C:\app\data2` 会被 `C:\app\data` 误判为在内。
fn is_within(child: &Path, root: &Path) -> bool {
    fn keys(p: &Path) -> Vec<String> {
        p.components()
            .map(|c| {
                let s = c.as_os_str().to_string_lossy();
                #[cfg(windows)]
                {
                    s.to_lowercase()
                }
                #[cfg(not(windows))]
                {
                    s.into_owned()
                }
            })
            .collect()
    }
    let c = keys(child);
    let r = keys(root);
    c.len() > r.len() && c[..r.len()] == r[..]
}

fn is_unc(p: &Path) -> bool {
    // Rust 1.96 起 std::path::PrefixKind 并入 std::path::Prefix
    use std::path::{Component, Prefix};
    if let Some(Component::Prefix(pre)) = p.components().next() {
        return matches!(pre.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..));
    }
    false
}

/// 纯判定（供 validate_path 与单元测试共用）：canonical 后的路径是否被允许。
fn check_allowed(canonical: &Path, roots: &[PathBuf], registry: &HashSet<String>) -> bool {
    if registry.contains(&norm_key(canonical)) {
        return true;
    }
    roots.iter().any(|root| {
        std::fs::canonicalize(root)
            .map(|croot| is_within(canonical, &croot))
            .unwrap_or(false)
    })
}

/// 统一路径校验：canonicalize 解析 `..`/符号链接/verbatim 前缀后，
/// 要求落在允许根目录内或命中剪贴板捕获登记表。返回 canonical 路径供 IO 使用。
pub fn validate_path(path: &str) -> Result<PathBuf, Reject> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(Reject::Denied);
    }
    // UNC 一律拒绝：Explorer/网络重定向可被用来向外部主机泄露 NTLM 凭据
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return Err(Reject::Denied);
    }
    let p = Path::new(trimmed);
    let canonical = std::fs::canonicalize(p).map_err(|_| Reject::NotFound)?;
    if is_unc(&canonical) {
        return Err(Reject::Denied);
    }
    let st = lock();
    let Some(st) = st.as_ref() else {
        // 未初始化（正常流程不会出现）→ fail closed
        error!("[FileGuard] not initialized — rejecting");
        return Err(Reject::Denied);
    };
    if check_allowed(&canonical, &st.roots, &st.registry) {
        Ok(canonical)
    } else {
        debug!("[FileGuard] rejected path outside allowed set");
        Err(Reject::Denied)
    }
}

/// 登记本机剪贴板捕获到的文件路径（唯一合法的"任意位置"授权来源）。
/// 由 clipboard_monitor（FILES 事件）与 get_clipboard_files（轮询兜底）调用。
pub fn register_paths<'a, I: IntoIterator<Item = &'a str>>(paths: I) {
    let mut canonical_keys: Vec<String> = Vec::new();
    for raw in paths {
        if raw.trim().is_empty() || raw.starts_with("\\\\") || raw.starts_with("//") {
            continue;
        }
        match std::fs::canonicalize(raw.trim()) {
            Ok(c) if !is_unc(&c) => canonical_keys.push(norm_key(&c)),
            // 捕获与登记之间文件被删/移 → 读它本来也会失败，跳过即可
            _ => {}
        }
    }
    if canonical_keys.is_empty() {
        return;
    }
    let mut st = lock();
    let Some(st) = st.as_mut() else {
        error!("[FileGuard] not initialized — cannot register captured paths");
        return;
    };
    let mut changed = false;
    for key in canonical_keys {
        if st.registry.insert(key.clone()) {
            st.order.push_back(key);
            changed = true;
            while st.order.len() > MAX_REGISTRY_ENTRIES {
                if let Some(old) = st.order.pop_front() {
                    st.registry.remove(&old);
                }
            }
        }
    }
    if changed {
        persist_locked(st);
    }
}

/// `\\?\C:\x` → `C:\x`（CF_HDROP / explorer 等消费方不认 verbatim 前缀时使用）。
#[cfg(windows)]
pub fn to_display_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            return PathBuf::from(format!(r"\\{}", unc));
        }
        return PathBuf::from(rest);
    }
    p.to_path_buf()
}

#[cfg(not(windows))]
pub fn to_display_path(p: &Path) -> PathBuf {
    p.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Sandbox {
        base: PathBuf,
    }

    impl Sandbox {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "clipsync_file_guard_test_{}_{}",
                tag,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&base).unwrap();
            Self { base }
        }
        fn dir(&self, name: &str) -> PathBuf {
            let p = self.base.join(name);
            fs::create_dir_all(&p).unwrap();
            p
        }
        fn file(&self, rel: &str, content: &str) -> PathBuf {
            let p = self.base.join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, content).unwrap();
            p
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn canon(p: &Path) -> PathBuf {
        fs::canonicalize(p).unwrap()
    }

    /// 正常路径：root 内的文件通过
    #[test]
    fn allows_file_inside_root() {
        let sb = Sandbox::new("inside");
        let root = sb.dir("data");
        let f = sb.file("data/a.txt", "hello");
        assert!(check_allowed(&canon(&f), &[canon(&root)], &HashSet::new()));
    }

    /// `..` 穿越：字面上以 root 开头、解析后在 root 外 → 拒绝
    #[test]
    fn rejects_dotdot_traversal() {
        let sb = Sandbox::new("traversal");
        let root = sb.dir("data");
        let secret = sb.file("secret.txt", "top secret");
        // data/../secret.txt 字面位于 root 之下
        let traversal = root.join("..").join("secret.txt");
        let canonical = canon(&traversal);
        assert_eq!(canonical, canon(&secret));
        assert!(!check_allowed(&canonical, &[canon(&root)], &HashSet::new()));
    }

    /// 前缀相似目录：`…\data2` 不在 `…\data` 内（字符串 starts_with 会误判）
    #[test]
    fn rejects_prefix_lookalike_dir() {
        let sb = Sandbox::new("prefix");
        let root = sb.dir("data");
        let lookalike = sb.dir("data2");
        let f = sb.file("data2/b.txt", "x");
        // 字符串前缀确实相似——正是要防的误判
        assert!(lookalike.to_string_lossy().starts_with(&root.to_string_lossy().to_string()));
        assert!(!check_allowed(&canon(&f), &[canon(&root)], &HashSet::new()));
        // is_within 分量级语义单独断言（不依赖文件系统）
        assert!(is_within(
            Path::new(r"C:\app\data\sub\f.txt"),
            Path::new(r"C:\app\data")
        ));
        assert!(!is_within(
            Path::new(r"C:\app\data2\f.txt"),
            Path::new(r"C:\app\data")
        ));
        assert!(!is_within(Path::new(r"C:\app\data"), Path::new(r"C:\app\data")));
    }

    /// 登记表命中 → 通过；未命中 → 拒绝
    #[test]
    fn registry_membership() {
        let sb = Sandbox::new("registry");
        let root = sb.dir("data");
        let outside = sb.file("elsewhere/c.txt", "captured earlier");
        let mut registry = HashSet::new();
        registry.insert(norm_key(&canon(&outside)));
        assert!(check_allowed(&canon(&outside), &[canon(&root)], &registry));
        let not_registered = sb.file("elsewhere/d.txt", "never captured");
        assert!(!check_allowed(
            &canon(&not_registered),
            &[canon(&root)],
            &registry
        ));
    }

    /// 符号链接/junction 指向 root 外 → canonicalize 解析后拒绝。
    /// Windows 用 junction（免管理员权限）；创建失败则跳过而非失败。
    #[test]
    fn rejects_symlink_escape() {
        let sb = Sandbox::new("symlink");
        let root = sb.dir("data");
        let outside_dir = sb.dir("outside");
        let secret = sb.file("outside/secret.txt", "top secret");
        let link = root.join("escape");

        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_dir(&outside_dir, &link).is_ok() || {
            // symlink_dir 需要管理员/开发者模式；退回 junction（mklink /J 免特权）
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside_dir)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(&outside_dir, &link).is_ok();
        #[cfg(not(any(windows, unix)))]
        let created = false;

        if !created {
            eprintln!("symlink/junction creation unavailable on this host — skipping");
            return;
        }
        let through_link = link.join("secret.txt");
        let canonical = canon(&through_link);
        assert_eq!(canonical, canon(&secret));
        assert!(!check_allowed(&canonical, &[canon(&root)], &HashSet::new()));
    }

    /// UNC 路径拒绝（validate_path 前置检查，不触网）
    #[test]
    fn rejects_unc_paths() {
        assert!(matches!(
            validate_path(r"\\evil.example.com\share\file.txt"),
            Err(Reject::Denied)
        ));
        assert!(matches!(validate_path("//evil.example.com/share/f"), Err(Reject::Denied)));
        assert!(is_unc(Path::new(r"\\server\share")));
        assert!(!is_unc(Path::new(r"C:\dir")));
    }

    /// 空路径拒绝
    #[test]
    fn rejects_empty_path() {
        assert!(matches!(validate_path("   "), Err(Reject::Denied)));
    }

    /// verbatim 前缀还原（CF_HDROP 消费方不认 `\\?\`）
    #[cfg(windows)]
    #[test]
    fn display_path_strips_verbatim_prefix() {
        assert_eq!(
            to_display_path(Path::new(r"\\?\C:\Users\x\a.txt")).to_string_lossy(),
            r"C:\Users\x\a.txt"
        );
        assert_eq!(
            to_display_path(Path::new(r"\\?\UNC\server\share\a.txt")).to_string_lossy(),
            r"\\server\share\a.txt"
        );
        assert_eq!(
            to_display_path(Path::new(r"C:\plain\a.txt")).to_string_lossy(),
            r"C:\plain\a.txt"
        );
    }
}
