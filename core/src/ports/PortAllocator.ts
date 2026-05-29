// Port for finding an unused TCP port for the worker's loopback HTTP server.
// Pulled out of the supervisor so impls aren't forced to do networking.
export interface PortAllocator {
  allocate(): Promise<number>;
  release(port: number): void;
}
