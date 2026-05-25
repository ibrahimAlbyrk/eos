import type { EventBus, EventBusMessage } from "../ports/EventBus.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { NotificationConfig, NotificationPayload, NotificationTriggerName } from "../../../contracts/src/notifications.ts";

export interface NotificationTrigger {
  id: NotificationTriggerName;
  topic: string;
  shouldFire(msg: EventBusMessage, workers: WorkerRepo): NotificationPayload | null;
}

export interface NotificationServiceDeps {
  bus: EventBus;
  workers: WorkerRepo;
  getConfig: () => NotificationConfig;
}

export class NotificationService {
  private cooldowns = new Map<string, number>();
  private unsubscribes: Array<() => void> = [];
  private deps: NotificationServiceDeps;
  private triggers: NotificationTrigger[];

  constructor(deps: NotificationServiceDeps, triggers: NotificationTrigger[]) {
    this.deps = deps;
    this.triggers = triggers;
  }

  start(): void {
    for (const trigger of this.triggers) {
      const unsub = this.deps.bus.subscribe(trigger.topic as any, (msg) => {
        this.evaluate(trigger, msg);
      });
      this.unsubscribes.push(unsub);
    }
  }

  stop(): void {
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes = [];
  }

  private evaluate(trigger: NotificationTrigger, msg: EventBusMessage): void {
    const config = this.deps.getConfig();
    if (!config.enabled) return;

    const rule = config.rules[trigger.id];
    if (!rule?.enabled) return;

    const payload = trigger.shouldFire(msg, this.deps.workers);
    if (!payload) return;

    const cooldownKey = `${trigger.id}:${payload.workerId ?? "global"}`;
    const last = this.cooldowns.get(cooldownKey) ?? 0;
    const now = Date.now();
    if (now - last < rule.cooldownMs) return;

    this.cooldowns.set(cooldownKey, now);
    this.deps.bus.publish("notification:fire", payload);
  }
}
