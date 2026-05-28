import { AppLayout } from "../../components/layout/AppLayout.jsx";
import { TabBar } from "../../components/TabBar.jsx";
import { WorkflowsEmpty } from "./WorkflowsEmpty.jsx";

export function WorkflowsView() {
  return (
    <AppLayout
      sidebar={
        <div className="side-island side-island--agents">
          <TabBar />
          <div className="sb-head">
            <div className="sb-head__title">Workflows</div>
          </div>
        </div>
      }
      main={<WorkflowsEmpty />}
    />
  );
}
