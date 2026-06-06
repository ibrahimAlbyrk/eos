import { useMemo } from "react";
import { NavigationProvider, useNavigation } from "./navigation.jsx";
import { SelectionProvider, useSelection } from "./selection.jsx";
import { ComposerProvider, useComposer } from "./composer.jsx";
import { AttentionProvider, useAttention } from "./attention.jsx";
import { SearchProvider, useSearch } from "./search.jsx";
import { SettingsProvider, useSettings } from "./settings.jsx";

export { useNavigation } from "./navigation.jsx";
export { useSelection } from "./selection.jsx";
export { useComposer } from "./composer.jsx";
export { useAttention, useAttentionSync } from "./attention.jsx";
export { useSearch } from "./search.jsx";
export { useSettings } from "./settings.jsx";

export function UiProvider({ children }) {
  return (
    <NavigationProvider>
      <SelectionProvider>
        <ComposerProvider>
          <AttentionProvider>
            <SearchProvider>
              <SettingsProvider>
                {children}
              </SettingsProvider>
            </SearchProvider>
          </AttentionProvider>
        </ComposerProvider>
      </SelectionProvider>
    </NavigationProvider>
  );
}

export function useUi() {
  const navigation = useNavigation();
  const selection = useSelection();
  const composer = useComposer();
  const attention = useAttention();
  const search = useSearch();
  const settings = useSettings();

  return useMemo(() => ({
    ...navigation,
    ...selection,
    ...composer,
    ...attention,
    ...search,
    ...settings,
  }), [navigation, selection, composer, attention, search, settings]);
}
