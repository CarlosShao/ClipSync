use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use aes_gcm::aead::rand_core::RngCore;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

const NONCE_SIZE: usize = 12;
const KEY_SIZE: usize = 32;

/// Generate a new 256-bit encryption key
pub fn generate_key() -> [u8; KEY_SIZE] {
    let mut key = [0u8; KEY_SIZE];
    OsRng.fill_bytes(&mut key);
    key
}

/// Encrypt plaintext using AES-256-GCM
/// Returns: base64-encoded(nonce + ciphertext)
pub fn encrypt(plaintext: &[u8], key: &[u8; KEY_SIZE]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| format!("Failed to create cipher: {}", e))?;

    let mut nonce_bytes = [0u8; NONCE_SIZE];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("Encryption failed: {}", e))?;

    let mut result = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);

    Ok(BASE64.encode(&result))
}

/// Decrypt base64-encoded(nonce + ciphertext) using AES-256-GCM
pub fn decrypt(encoded: &str, key: &[u8; KEY_SIZE]) -> Result<Vec<u8>, String> {
    let data = BASE64
        .decode(encoded)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;

    if data.len() < NONCE_SIZE {
        return Err("Data too short".to_string());
    }

    let (nonce_bytes, ciphertext) = data.split_at(NONCE_SIZE);
    let nonce = Nonce::from_slice(nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| format!("Failed to create cipher: {}", e))?;

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("Decryption failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = generate_key();
        let plaintext = b"Hello, ClipSync! This is a test message.";

        let encrypted = encrypt(plaintext, &key).unwrap();
        let decrypted = decrypt(&encrypted, &key).unwrap();

        assert_eq!(plaintext.to_vec(), decrypted);
    }

    #[test]
    fn test_different_nonces() {
        let key = generate_key();
        let plaintext = b"Same message";

        let enc1 = encrypt(plaintext, &key).unwrap();
        let enc2 = encrypt(plaintext, &key).unwrap();

        assert_ne!(enc1, enc2);
    }
}
