use log::{error, info};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use crate::crypto;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncMessage {
    pub msg_type: String,
    pub device_id: Option<String>,
    pub content: Option<String>,
    pub content_type: Option<String>,
    pub timestamp: Option<i64>,
}

pub struct SyncClient {
    server_url: String,
    token: String,
    device_id: String,
    encryption_key: [u8; 32],
    tx: mpsc::Sender<SyncMessage>,
}

impl SyncClient {
    pub fn new(
        server_url: String,
        token: String,
        device_id: String,
        encryption_key: [u8; 32],
    ) -> (Self, mpsc::Receiver<SyncMessage>) {
        let (tx, rx) = mpsc::channel(100);
        let client = Self {
            server_url,
            token,
            device_id,
            encryption_key,
            tx,
        };
        (client, rx)
    }

    /// Encrypt and upload clipboard content
    pub async fn upload_clipboard(&self, content: &str, content_type: &str) -> Result<(), String> {
        let encrypted = crypto::encrypt(content.as_bytes(), &self.encryption_key)?;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/api/clipboard", self.server_url))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({
                "sourceDeviceId": self.device_id,
                "contentType": content_type,
                "contentEncrypted": encrypted,
                "contentPreview": content.chars().take(200).collect::<String>(),
                "contentSize": content.len(),
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if resp.status().is_success() {
            info!("Clipboard uploaded successfully");
            Ok(())
        } else {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            Err(format!("Upload failed: {} {}", status, body))
        }
    }

    /// Download and decrypt clipboard content
    pub async fn download_clipboard(&self, item_id: &str) -> Result<String, String> {
        let client = reqwest::Client::new();
        let resp = client
            .get(format!("{}/api/clipboard/{}", self.server_url, item_id))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("Download failed: {}", resp.status()));
        }

        let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let encrypted = body["contentEncrypted"]
            .as_str()
            .ok_or("Missing contentEncrypted")?;

        let decrypted = crypto::decrypt(encrypted, &self.encryption_key)?;
        let content = String::from_utf8(decrypted).map_err(|e| e.to_string())?;

        Ok(content)
    }

    pub fn get_device_id(&self) -> &str {
        &self.device_id
    }
}
