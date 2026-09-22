/**
 * Rotation across free endpoints, with per-endpoint cooldowns.
 *
 * The design rests on one measured fact: SiliconFlow's free per-minute token
 * allowance is **per model, not per account**. Exhausting `Qwen/Qwen2.5-7B` to
 * its 50,000 TPM ceiling and then immediately calling three other free models
 * returned 200 from all three. So a throttled model can be side-stepped rather
 * than waited out, and the six free chat models together offer roughly
 * 300,000 TPM of usable capacity.
 *
 * A rate-limited endpoint is parked for a cooldown window rather than retried
 * immediately: the allowance is per MINUTE, so retrying inside that window would
 * burn latency and produce the same 429. The parked endpoint becomes eligible
 * again automatically once the window passes, so no manual reset exists.
 *
 * The local llama.cpp server is the floor of the chain: it has no quota at all,
 * which is exactly what makes it the right last resort rather than the first.
 *
 * @module local-offload/rotation
 */

/** Default park duration after a 429. The allowance is per minute. */
export const DEFAULT_COOLDOWN_MS = 65_000

/**
 * Ordered endpoints to try, with remembered cooldowns.
 *
 * Order is significant: earlier entries are cheaper or preferred. Measurement
 * on this machine put `Qwen/Qwen2.5-7B-Instruct` first (0.5 s, non-thinking),
 * then `THUDM/GLM-4-9B-0414`, then `Qwen/Qwen3-8B`. The reasoning-only models
 * are deliberately absent: they ignore `enable_thinking: false` and spend 68-143
 * output tokens saying one word.
 */
export class EndpointChain {
  /**
   * @param {{baseUrl: string, model: string, apiKey?: string, timeoutMs?: number}[]} entries
   * @param {{cooldownMs?: number, now?: () => number, onEvent?: (e: object) => void}} [options]
   */
  constructor(entries, options = {}) {
    this.entries = entries.map((e) => ({ ...e, baseUrl: String(e.baseUrl).replace(/\/+$/, '') }))
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.now = options.now ?? (() => Date.now())
    this.onEvent = options.onEvent ?? (() => {})
    /** @type {Map<string, number>} endpoint key -> epoch ms when it becomes usable */
    this.parked = new Map()
  }

  static keyOf(entry) {
    return `${entry.baseUrl}|${entry.model}`
  }

  /** Mark an endpoint throttled for the cooldown window. */
  park(entry, reason) {
    const until = this.now() + this.cooldownMs
    this.parked.set(EndpointChain.keyOf(entry), until)
    this.onEvent({ type: 'park', endpoint: EndpointChain.keyOf(entry), until, reason })
  }

  /** Drop expired parks. Called before each selection so recovery is automatic. */
  sweep() {
    const now = this.now()
    for (const [key, until] of this.parked) {
      if (until <= now) {
        this.parked.delete(key)
        this.onEvent({ type: 'unpark', endpoint: key })
      }
    }
  }

  /** True when the endpoint is currently parked. */
  isParked(entry) {
    const until = this.parked.get(EndpointChain.keyOf(entry))
    return until !== undefined && until > this.now()
  }

  /** Seconds until the soonest park expires, or 0 when nothing is parked. */
  soonestRecoverySeconds() {
    const now = this.now()
    let soonest
    for (const until of this.parked.values()) {
      if (until <= now) continue
      if (soonest === undefined || until < soonest) soonest = until
    }
    return soonest === undefined ? 0 : Math.ceil((soonest - now) / 1000)
  }

  /**
   * Endpoints to try, parked ones last.
   *
   * They are appended rather than dropped: if every endpoint is parked, trying a
   * parked one is strictly better than failing outright, because the park is a
   * prediction and the provider may have released the allowance early.
   */
  ordered() {
    this.sweep()
    const fresh = this.entries.filter((e) => !this.isParked(e))
    const parked = this.entries.filter((e) => this.isParked(e))
    return { fresh, parked, all: [...fresh, ...parked] }
  }

  /** One-line report of chain state, for the tool's trailing note. */
  describe() {
    this.sweep()
    const parts = this.entries.map((e) => {
      const until = this.parked.get(EndpointChain.keyOf(e))
      if (until === undefined || until <= this.now()) return `${e.model}=ready`
      return `${e.model}=parked ${Math.ceil((until - this.now()) / 1000)}s`
    })
    return parts.join(', ')
  }
}
