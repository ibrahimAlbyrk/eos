import { useMemo } from "react";
import { SelectionProvider, useSelection } from "./selection.jsx";
import { ComposerProvider, useComposer } from "./composer.jsx";
import { NotificationProvider, useNotification } from "./notification.jsx";

export { useSelection } from "./selection.jsx";
export { useComposer } from "./composer.jsx";
export { useNotification } from "./notification.jsx";

export function UiProvider({ children }) {
  return (
    <SelectionProvider>
      <ComposerProvider>
        <NotificationProvider>
          {children}
        </NotificationProvider>
      </ComposerProvider>
    </SelectionProvider>
  );
}

export function useUi() {
  const selection = useSelection();
  const composer = useComposer();
  const notification = useNotification();

  return useMemo(() => ({
    ...selection,
    ...composer,
    ...notification,
  }), [selection, composer, notification]);
}
