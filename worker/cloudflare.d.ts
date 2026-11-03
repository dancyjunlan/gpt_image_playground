/**
 * Worker 运行时用到的最小类型声明。
 * 项目不引入 @cloudflare/workers-types，这里只声明实际用到的成员，避免多一份依赖。
 */

interface DurableObjectId {
  toString(): string
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  setAlarm(scheduledTime: number | Date): Promise<void>
}

interface DurableObjectState {
  readonly id: DurableObjectId
  readonly storage: DurableObjectStorage
}

interface DurableObjectStub {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}
