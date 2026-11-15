import type { Post } from "@svett/core";

/** What a post screen changed that the feed shows too. */
export type PostChange = Pick<Post, "likes" | "liked"> | Pick<Post, "comments">;

type Listener = (postId: string, change: PostChange) => void;

const listeners = new Set<Listener>();

/** Tells every feed on screen that a post's likes or comments changed. */
export const postChanged = (postId: string, change: PostChange) => {
  for (const listener of listeners) listener(postId, change);
};

/** Calls `listener` for each change until the returned function is called. */
export const onPostChange = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
