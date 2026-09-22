// Unit-test the rotation logic without touching the network.
//
// Rotation is the kind of code that looks right and fails in the interesting
// case: the second 429, or a recovery that never happens because nothing sweeps
// the park. These cases pin the behaviour that a live test cannot force on
// demand (you cannot ask SiliconFlow for a 429).
//
// Usage: node <this-repo>\test\test-rotation.mjs
import { EndpointChain, DEFAULT_COOLDOWN_MS } from '../lib/rotation.js'

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
  if (ok) pass++
  else fail++
}

const A = { baseUrl: 'https://free.example/v1', model: 'model-a' }
const B = { baseUrl: 'https://free.example/v1', model: 'model-b' }
const L = { baseUrl: 'http://127.0.0.1:18080', model: 'local' }

console.log('== identity ==')
check('endpoints are distinguished by url AND model',
  EndpointChain.keyOf(A) !== EndpointChain.keyOf(B),
  `${EndpointChain.keyOf(A)} vs ${EndpointChain.keyOf(B)}`)
check('same endpoint has a stable key', EndpointChain.keyOf(A) === EndpointChain.keyOf({ ...A }))

console.log('\n== cooldown default ==')
check('default cooldown covers a per-minute allowance', DEFAULT_COOLDOWN_MS >= 60_000, `${DEFAULT_COOLDOWN_MS}ms`)

console.log('\n== parking skips an endpoint, then restores it ==')
let clock = 1_000_000
const events = []
const chain = new EndpointChain([A, B, L], { cooldownMs: 60_000, now: () => clock, onEvent: (e) => events.push(e) })

check('nothing parked initially', chain.isParked(A) === false)
check('order is the configured order',
  chain.ordered().all.map((e) => e.model).join(',') === 'model-a,model-b,local')

chain.park(A, 'RATE_LIMITED')
check('a parked endpoint reports parked', chain.isParked(A) === true)
check('a parked endpoint drops to the back',
  chain.ordered().all.map((e) => e.model).join(',') === 'model-b,local,model-a',
  chain.ordered().all.map((e) => e.model).join(','))
check('a parked endpoint is still tried last rather than dropped',
  chain.ordered().all.length === 3, 'never fail outright while a prediction is unproven')
check('parking emits an event', events.some((e) => e.type === 'park'))

console.log('\n== recovery is automatic, with no manual reset ==')
check('still parked 30s later', (clock += 30_000, chain.isParked(A) === true), `+30s, ${chain.soonestRecoverySeconds()}s left`)
check('recovery countdown is reported', chain.soonestRecoverySeconds() > 0 && chain.soonestRecoverySeconds() <= 30, `${chain.soonestRecoverySeconds()}s`)
check('expired park no longer counts as parked', (clock += 31_000, chain.isParked(A) === false), '+61s')
check('it returns to its original position',
  chain.ordered().all.map((e) => e.model).join(',') === 'model-a,model-b,local',
  chain.ordered().all.map((e) => e.model).join(','))
check('unparking emits an event', events.some((e) => e.type === 'unpark'))

console.log('\n== several endpoints can be parked at once ==')
const c2 = new EndpointChain([A, B, L], { cooldownMs: 60_000, now: () => clock })
c2.park(A, 'RATE_LIMITED')
c2.park(B, 'RATE_LIMITED')
check('both parked, local is first in line',
  c2.ordered().all.map((e) => e.model).join(',') === 'local,model-a,model-b',
  c2.ordered().all.map((e) => e.model).join(','))
check('soonest recovery reflects the earliest park', c2.soonestRecoverySeconds() > 0)

console.log('\n== local server is the floor ==')
const c3 = new EndpointChain([A, L], { cooldownMs: 60_000, now: () => clock })
c3.park(A, 'RATE_LIMITED')
check('when the free route is parked the local route leads',
  c3.ordered().all[0].model === 'local', c3.ordered().all[0].model)

console.log('\n== describe() is readable enough to put in a tool result ==')
const c4 = new EndpointChain([A, B], { cooldownMs: 60_000, now: () => clock })
c4.park(A, 'RATE_LIMITED')
const desc = c4.describe()
check('names each endpoint and its state', /model-a=parked \d+s/.test(desc) && /model-b=ready/.test(desc), desc)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
