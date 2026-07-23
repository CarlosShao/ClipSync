import { ref, computed } from 'vue'
import { api } from '@/api/client'

/**
 * Unified Protection Level System - Frontend Composable
 *
 * Protection levels:
 * - 'none': No protection
 * - 'pin': PIN protection (temporary access, auto-relock)
 * - 'advanced': Advanced encryption (DEK dual encryption + recovery key)
 */

export type ProtectionLevel = 'none' | 'pin' | 'advanced'

interface ProtectionStatus {
  level: ProtectionLevel
  hasRecoveryKey: boolean
}

interface SetupResult {
  success: boolean
  level: ProtectionLevel
  recoveryKey?: string // Only returned for advanced level
}

interface UnlockResult {
  success: boolean
  level: ProtectionLevel
  content?: string
}

export function useProtection() {
  const loading = ref(false)
  const error = ref<string | null>(null)

  // Cache for protection status
  const protectionCache = ref<Map<string, ProtectionStatus>>(new Map())

  /**
   * Get protection status for an item
   */
  async function getStatus(itemId: string): Promise<ProtectionStatus | null> {
    try {
      const response = await api('GET', `/api/protection/status/${itemId}`)
      if (response.ok && response.data) {
        const status = response.data as ProtectionStatus
        protectionCache.value.set(itemId, status)
        return status
      }
      return null
    } catch (err: any) {
      console.error('Failed to get protection status:', err)
      return null
    }
  }

  /**
   * Set up protection for an item
   * @param itemId - Item ID
   * @param level - Protection level ('pin' or 'advanced')
   * @param password - Password (required for advanced level)
   * @param content - Content to encrypt (required for advanced level)
   * @returns Setup result with recovery key for advanced level
   */
  async function setupProtection(
    itemId: string,
    level: 'pin' | 'advanced',
    password?: string,
    content?: string,
  ): Promise<SetupResult | null> {
    loading.value = true
    error.value = null

    try {
      const body: any = { itemId, level }

      if (level === 'advanced') {
        if (!password || password.length < 4) {
          throw new Error('Password must be at least 4 characters')
        }
        if (!content) {
          throw new Error('Content is required for advanced protection')
        }
        body.password = password
        body.content = content
      }

      const response = await api('POST', '/api/protection/setup', body)

      if (response.ok && response.data) {
        const result = response.data as SetupResult

        // Update cache
        protectionCache.value.set(itemId, { level, hasRecoveryKey: !!result.recoveryKey })

        return result
      } else {
        throw new Error(response.error || 'Failed to set up protection')
      }
    } catch (err: any) {
      error.value = err.message
      return null
    } finally {
      loading.value = false
    }
  }

  /**
   * Unlock a protected item
   * @param itemId - Item ID
   * @param password - Password
   * @returns Decrypted content
   */
  async function unlock(itemId: string, password: string): Promise<string | null> {
    loading.value = true
    error.value = null

    try {
      const response = await api('POST', '/api/protection/unlock', {
        itemId,
        password,
      })

      if (response.ok && response.data) {
        const result = response.data as UnlockResult
        return result.content || null
      } else {
        throw new Error(response.error || 'Failed to unlock')
      }
    } catch (err: any) {
      error.value = err.message
      return null
    } finally {
      loading.value = false
    }
  }

  /**
   * Unlock with recovery key
   * @param itemId - Item ID
   * @param recoveryKey - Recovery key (128 hex characters)
   * @returns Decrypted content
   */
  async function unlockWithRecovery(itemId: string, recoveryKey: string): Promise<string | null> {
    loading.value = true
    error.value = null

    try {
      const response = await api('POST', '/api/protection/recovery', {
        itemId,
        recoveryKey,
      })

      if (response.ok && response.data) {
        const result = response.data as UnlockResult
        return result.content || null
      } else {
        throw new Error(response.error || 'Failed to unlock with recovery key')
      }
    } catch (err: any) {
      error.value = err.message
      return null
    } finally {
      loading.value = false
    }
  }

  /**
   * Rotate password for a protected item
   * @param itemId - Item ID
   * @param oldPassword - Current password
   * @param newPassword - New password
   */
  async function rotatePassword(itemId: string, oldPassword: string, newPassword: string): Promise<boolean> {
    loading.value = true
    error.value = null

    try {
      if (newPassword.length < 4) {
        throw new Error('New password must be at least 4 characters')
      }

      const response = await api('POST', '/api/protection/rotate-password', {
        itemId,
        oldPassword,
        newPassword,
      })

      return response.ok
    } catch (err: any) {
      error.value = err.message
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * Remove protection from an item
   * @param itemId - Item ID
   * @param password - Password (required for advanced level)
   * @returns Decrypted content (for advanced level)
   */
  async function removeProtection(itemId: string, password?: string): Promise<string | null> {
    loading.value = true
    error.value = null

    try {
      const response = await api('POST', '/api/protection/remove', {
        itemId,
        password,
      })

      if (response.ok) {
        const result = response.data as { content?: string }

        // Update cache
        protectionCache.value.set(itemId, { level: 'none', hasRecoveryKey: false })

        return result.content || null
      } else {
        throw new Error(response.error || 'Failed to remove protection')
      }
    } catch (err: any) {
      error.value = err.message
      return null
    } finally {
      loading.value = false
    }
  }

  /**
   * Get protection level for an item (from cache or API)
   */
  function getLevel(itemId: string): ProtectionLevel {
    const cached = protectionCache.value.get(itemId)
    return cached?.level || 'none'
  }

  /**
   * Check if an item is protected
   */
  function isProtected(itemId: string): boolean {
    return getLevel(itemId) !== 'none'
  }

  /**
   * Check if an item uses advanced protection
   */
  function isAdvanced(itemId: string): boolean {
    return getLevel(itemId) === 'advanced'
  }

  /**
   * Clear protection cache
   */
  function clearCache() {
    protectionCache.value.clear()
  }

  return {
    // State
    loading,
    error,

    // Methods
    getStatus,
    setupProtection,
    unlock,
    unlockWithRecovery,
    rotatePassword,
    removeProtection,
    getLevel,
    isProtected,
    isAdvanced,
    clearCache,
  }
}
