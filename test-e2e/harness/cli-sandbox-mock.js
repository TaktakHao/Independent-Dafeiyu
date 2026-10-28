/**
 * @file cli-sandbox-mock.js
 * 模拟 Tier 1 Agent CLI (agy / cursor-agent) 独立沙箱调用、额度耗尽检测与熔断器
 */

export class AgentCliSandboxMock {
  constructor(options = {}) {
    this.name = options.name || 'agy'
    this.quotaExhausted = false
    this.authRequired = false
    this.failCount = 0
    this.circuitBreakerTrippedUntil = 0
    this.invocations = []
  }

  setQuotaExhausted(exhausted = true) {
    this.quotaExhausted = exhausted
  }

  setAuthRequired(required = true) {
    this.authRequired = required
  }

  isAvailable() {
    if (this.quotaExhausted || this.authRequired) return false
    if (Date.now() < this.circuitBreakerTrippedUntil) return false
    return true
  }

  /**
   * 模拟在隔离目录执行 CLI 命令
   */
  async execute(prompt, sandboxDir) {
    this.invocations.push({ prompt, sandboxDir, timestamp: Date.now() })

    // 检查熔断器状态
    if (Date.now() < this.circuitBreakerTrippedUntil) {
      const remainingMs = this.circuitBreakerTrippedUntil - Date.now()
      throw new Error(`Circuit breaker is OPEN. Cooldown remaining: ${remainingMs}ms`)
    }

    if (this.quotaExhausted) {
      this._recordFailure()
      // 输出符合 EXHAUSTED 正则匹配的错误信息
      const err = new Error('Process exited with 1: [EXHAUSTED] [rate limit] API quota limit exceeded (429), 额度已达上限')
      err.code = 'EXHAUSTED'
      throw err
    }

    if (this.authRequired) {
      this._recordFailure()
      // 输出符合 NEEDS_AUTH 正则匹配的错误信息
      const err = new Error('Process exited with 1: Unauthorized, please login first to refresh credentials')
      err.code = 'NEEDS_AUTH'
      throw err
    }

    // 成功调用，重置失败计数
    this.failCount = 0

    return {
      clip: 'talking_normal',
      tone: 'happy',
      text: '老爸，我一直在呢！今天写代码辛苦啦~',
      moodIntent: 1,
    }
  }

  _recordFailure() {
    this.failCount++
    if (this.failCount >= 3) {
      // 触发 60 秒熔断器
      this.circuitBreakerTrippedUntil = Date.now() + 60000
    }
  }

  resetCircuitBreaker() {
    this.failCount = 0
    this.circuitBreakerTrippedUntil = 0
    this.quotaExhausted = false
    this.authRequired = false
  }
}
