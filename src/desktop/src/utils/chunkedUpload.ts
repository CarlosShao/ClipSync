/**
 * Chunked file upload for ClipSync desktop.
 *
 * Handles large files (>10MB) by splitting into 10MB chunks,
 * uploading sequentially, and merging on the server.
 *
 * Supports progress reporting, resume (skips already-uploaded chunks),
 * and persistence to localStorage for resume after page refresh.
 */

import { api } from '@/api/client'
import { logger } from './logger'

// Upload state persistence for resume after refresh
const UPLOAD_STATE_KEY = 'clipsync-chunked-upload'
interface UploadState { uploadId: string; filename: string; totalChunks: number; uploadedChunks: number[]; timestamp: number }
function saveUploadState(state: UploadState | null) {
  try { localStorage.setItem(UPLOAD_STATE_KEY, state ? JSON.stringify(state) : '') } catch (e) { console.warn('[ChunkedUpload] state persist failed:', e) }
}
function loadUploadState(): UploadState | null {
  try {
    const raw = localStorage.getItem(UPLOAD_STATE_KEY)
    if (!raw) return null
    const state: UploadState = JSON.parse(raw)
    // Expire after 24 hours
    if (Date.now() - state.timestamp > 24 * 60 * 60 * 1000) { localStorage.removeItem(UPLOAD_STATE_KEY); return null }
    return state
  } catch { return null }
}

const CHUNK_SIZE = 10 * 1024 * 1024 // 10MB per chunk (server limit)

export interface UploadProgress {
  uploadId: string
  filename: string
  totalChunks: number
  uploadedChunks: number
  percent: number
  done: boolean
  error?: string
}

/** Initialize a chunked upload session. */
async function initUpload(file: File): Promise<string> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  const res = await api('POST', '/api/upload/init', {
    filename: file.name,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    totalChunks,
  })
  if (!res.ok || !res.data?.uploadId) {
    throw new Error(res.error || 'Failed to init upload')
  }
  return res.data.uploadId
}

/** Upload a single chunk with retry (max 3 attempts). */
async function uploadChunk(uploadId: string, chunkIndex: number, chunk: Blob, retries = 3): Promise<void> {
  const formData = new FormData()
  formData.append('chunk', chunk, 'chunk')
  const config = (await import('@/stores/configStore')).useConfigStore()
  const token = config.config.token

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${config.serverUrl}/api/upload/chunk/${uploadId}/${chunkIndex}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
        credentials: 'include',
      })
      if (res.ok) return
      // 429 / 5xx: retry with backoff
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * attempt))
          continue
        }
      }
      const text = await res.text()
      throw new Error(`Chunk ${chunkIndex} failed: ${res.status} ${text}`)
    } catch (e: any) {
      if (attempt < retries && (e.message?.includes('Failed to fetch') || e.message?.includes('NetworkError'))) {
        await new Promise(r => setTimeout(r, 1000 * attempt))
        continue
      }
      throw e
    }
  }
}

/** Complete (merge) the upload on the server. */
async function completeUpload(uploadId: string, deviceId?: string): Promise<any> {
  const res = await api('POST', `/api/upload/complete/${uploadId}`, { deviceId })
  if (!res.ok) throw new Error(res.error || 'Failed to complete upload')
  return res.data
}

/** Get current upload status (for resume). */
async function getUploadStatus(uploadId: string): Promise<{ missingChunks: number[]; uploadedChunks: number[] }> {
  const res = await api('GET', `/api/upload/status/${uploadId}`)
  if (!res.ok) throw new Error(res.error || 'Failed to get status')
  return { missingChunks: res.data.missingChunks, uploadedChunks: res.data.uploadedChunks }
}

/**
 * Upload a file using chunked transfer.
 *
 * @param file - The File object to upload
 * @param onProgress - Progress callback (called after each chunk)
 * @param existingUploadId - If resuming, pass the previous uploadId
 * @returns The created clipboard item
 */
export async function chunkedUpload(
  file: File,
  onProgress?: (p: UploadProgress) => void,
  existingUploadId?: string,
): Promise<any> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

  // Try to resume from localStorage if no explicit uploadId
  let uploadId = existingUploadId
  let uploadedIndices: number[] = []

  if (!uploadId) {
    const saved = loadUploadState()
    if (saved && saved.filename === file.name && saved.totalChunks === totalChunks) {
      uploadId = saved.uploadId
      uploadedIndices = saved.uploadedChunks
      logger.debug(`[ChunkedUpload] Resuming upload ${uploadId} from chunk ${uploadedIndices.length}/${totalChunks}`)
    }
  }

  // Validate or initialize upload session
  if (uploadId) {
    try {
      const status = await getUploadStatus(uploadId)
      uploadedIndices = status.uploadedChunks
    } catch {
      // Session expired or not found — re-init
      uploadId = undefined
      uploadedIndices = []
    }
  }

  if (!uploadId) {
    uploadId = await initUpload(file)
  }

  // Save state for resume after refresh
  saveUploadState({ uploadId, filename: file.name, totalChunks, uploadedChunks: uploadedIndices, timestamp: Date.now() })

  // Upload each chunk (skip already uploaded)
  for (let i = 0; i < totalChunks; i++) {
    if (uploadedIndices.includes(i)) continue

    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, file.size)
    const chunk = file.slice(start, end)

    await uploadChunk(uploadId, i, chunk)

    // Update saved state after each successful chunk
    uploadedIndices.push(i)
    saveUploadState({ uploadId, filename: file.name, totalChunks, uploadedChunks: uploadedIndices, timestamp: Date.now() })

    onProgress?.({
      uploadId,
      filename: file.name,
      totalChunks,
      uploadedChunks: uploadedIndices.length,
      percent: Math.round((uploadedIndices.length / totalChunks) * 100),
      done: false,
    })
  }

  // Complete the upload
  const deviceId = localStorage.getItem('clipsync-device-id') || undefined
  const result = await completeUpload(uploadId, deviceId)

  // Clean up saved state on success
  saveUploadState(null)

  onProgress?.({
    uploadId,
    filename: file.name,
    totalChunks,
    uploadedChunks: totalChunks,
    percent: 100,
    done: true,
  })

  return result
}

/** Check if a file should use chunked upload (>10MB). */
export function shouldUseChunkedUpload(file: File): boolean {
  return file.size > CHUNK_SIZE
}

/** Check if there's a pending upload that can be resumed. */
export function getPendingUpload(): UploadState | null {
  return loadUploadState()
}

/** Clear pending upload state. */
export function clearPendingUpload() {
  saveUploadState(null)
}
