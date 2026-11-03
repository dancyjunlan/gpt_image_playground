import { useState } from 'react'
import { submitAccessPassword } from '../lib/serverMode'

/** 部署端设置了访问口令时，页面先要求验证，验证通过才加载应用 */
export default function AccessGate({ onPassed }: { onPassed: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (!password.trim() || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await submitAccessPassword(password.trim())
      onPassed()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-950">
      <form
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm dark:bg-gray-900"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h1 className="text-lg font-medium text-gray-800 dark:text-gray-100">需要访问口令</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">这个部署只对内开放，请输入管理员提供的访问口令。</p>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          autoFocus
          placeholder="访问口令"
          className="mt-4 w-full rounded-xl border border-transparent bg-black/[0.04] px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:bg-white/[0.06] dark:text-gray-200 dark:focus:border-blue-500/50"
        />
        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !password.trim()}
          className="mt-4 w-full rounded-xl bg-blue-500 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? '验证中…' : '进入'}
        </button>
      </form>
    </div>
  )
}
