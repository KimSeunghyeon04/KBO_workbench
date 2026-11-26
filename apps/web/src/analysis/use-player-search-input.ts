import { useLayoutEffect, useRef, useState, type ChangeEvent, type CompositionEvent } from "react";

export function usePlayerSearchInput(search: string, onSearch: (value: string) => void) {
  const [draft, setDraft] = useState(search);
  const isComposing = useRef(false);
  const lastSearch = useRef(search);

  // Keep an active composition intact if a prior URL update arrives while typing.
  useLayoutEffect(() => {
    lastSearch.current = search;
    if (!isComposing.current) setDraft(search);
  }, [search]);

  function update(value: string) {
    setDraft(value);
    if (isComposing.current || value === lastSearch.current) return;
    lastSearch.current = value;
    onSearch(value);
  }

  return {
    isComposing,
    inputProps: {
      value: draft,
      onChange(event: ChangeEvent<HTMLInputElement>) {
        update(event.currentTarget.value);
      },
      onCompositionStart() {
        isComposing.current = true;
      },
      onCompositionEnd(event: CompositionEvent<HTMLInputElement>) {
        isComposing.current = false;
        update(event.currentTarget.value);
      },
    },
  };
}
