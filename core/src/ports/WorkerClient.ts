// WorkerClient — daemon → worker IPC port. Today the only operation is "send
// a message to the worker's PTY"; future operations (PTY resize, status
// probe) live here.

export interface WorkerClient {
  sendMessage(port: number, text: string): Promise<{ ok: boolean; status: number; body: unknown }>;
  sendInterrupt(port: number): Promise<{ ok: boolean; reason?: string }>;
}
