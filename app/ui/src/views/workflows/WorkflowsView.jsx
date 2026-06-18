import { AppLayout } from "../../components/layout/AppLayout.jsx";
import { TabBar } from "../../components/TabBar.jsx";
import { SettingsFooter } from "../../components/SettingsFooter.jsx";
import { WorkflowsEmpty } from "./WorkflowsEmpty.jsx";

export function WorkflowsSidebar({ variant }) {
  const body = (
    <>
      <TabBar variant={variant} />
      <div className="sb-head">
        <div className="sb-head__title">Workflows</div>
      </div>
      <SettingsFooter />
    </>
  );

  if (variant === "popup") return body;

  return <div className="side-island side-island--agents">{body}</div>;
}

export function WorkflowsView() {
  return (
    <AppLayout
      sidebar={(variant) => <WorkflowsSidebar variant={variant} />}
      main={<WorkflowsEmpty />}
    />
  );
}
