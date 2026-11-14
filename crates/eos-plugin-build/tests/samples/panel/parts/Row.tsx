export interface RowProps {
  name: string;
  count: number;
  index: number;
}

export function Row({ name, count, index }: RowProps) {
  return (
    <div className="row" style={{ order: index }}>
      {name}: {count ?? 0}
    </div>
  );
}
