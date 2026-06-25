'use client';

import { useListKeyboardNav, type ListKeyboardNavOptions } from '@/lib/use-list-keyboard-nav';

/**
 * Headless mount point for {@link useListKeyboardNav} so server-rendered
 * pages (which can't call hooks directly) can opt a list into j/k/gg/G
 * navigation by dropping this component in and tagging rows with the
 * matching selector attribute.
 */
export function ListKeyboardNav(props: ListKeyboardNavOptions) {
  useListKeyboardNav(props);
  return null;
}
