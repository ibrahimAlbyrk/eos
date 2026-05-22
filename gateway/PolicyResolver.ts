// Strategy interface — every concrete policy returns a Decision for a
// (tool_name, input) pair. Adding a new strategy is one new file; the
// gateway server picks one at startup based on env vars and never changes
// it mid-process.

export type AllowDecision = { behavior: "allow"; updatedInput: Record<string, unknown> };
export type DenyDecision = { behavior: "deny"; message: string };
export type Decision = AllowDecision | DenyDecision;

export interface PolicyResolver {
  readonly name: string;
  decide(input: {
    tool_name: string;
    input: Record<string, unknown>;
    tool_use_id?: string;
  }): Promise<Decision>;
}
