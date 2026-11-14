import { helper } from "../shared.js";
export default function activate(eos) {
  eos.mainViews.add({ id: "nested", render: () => <p>{helper()}</p> });
}
