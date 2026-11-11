const greet = (name) => `hello ${name}`;

export default function activate(eos) {
  eos.log?.(greet("eos"));
  return async () => {
    await Promise.resolve();
  };
}
