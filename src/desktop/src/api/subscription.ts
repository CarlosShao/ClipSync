import { api } from './client'

export function fetchSubscription() {
  return api('/api/subscription', 'GET')
}

export function cancelSubscription() {
  return api('/api/subscription/cancel', 'POST')
}

export function changePlan(planId: string) {
  return api('/api/subscription/change', 'POST', { planId })
}
