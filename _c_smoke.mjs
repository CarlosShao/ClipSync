import { setTimeout as sleep } from 'timers/promises'
const timer = setTimeout(() => { console.error('HUNG: module eval/completion >8s'); process.exit(2) }, 8000)
try {
  const m = await import('./src/server/src/routes/aiChat.js')
  console.log('aiChat READY router.post=', typeof m.default.post, 'approve importable')
} catch (e) {
  console.error('aiChat FAIL', e.message)
  process.exit(1)
}
clearTimeout(timer)
console.log('RESOLVED')
process.exit(0)