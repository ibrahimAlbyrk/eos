import { useMemo } from "react";
import { NavigationProvider, useNavigation } from "./navigation.jsx";
import { SelectionProvider, useSelection } from "./selection.jsx";
import { ComposerProvider, useComposer } from "./composer.jsx";
import { NotificationProvider, useNotification } from "./notification.jsx";

export { useNavigation } from "./navigation.jsx";
export { useSelection } from "./selection.jsx";
export { useComposer } from "./composer.jsx";
export { useNotification } from "./notification.jsx";

export function UiProvider({ children }) {
  return (
    <NavigationProvider>
      <SelectionProvider>
        <ComposerProvider>
          <NotificationProvider>
            {children}
          </NotificationProvider>
        </ComposerProvider>
      </SelectionProvider>
    </NavigationProvider>
  );
}

export function useUi() {
  const navigation = useNavigation();
  const selection = useSelection();
  const composer = useComposer();
  const notification = useNotification();

  return useMemo(() => ({
    ...navigation,
    ...selection,
    ...composer,
    ...notification,
  }), [navigation, selection, composer, notification]);
}
