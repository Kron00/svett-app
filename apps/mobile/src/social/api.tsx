import { useAuth } from "@clerk/expo";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  httpSocialApi,
  type SocialApi,
  SocialFailed,
  socialProblemMessage,
} from "@svett/core";
import { Cause, Effect, Exit, Option } from "effect";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";

import { CLERK_PUBLISHABLE_KEY } from "../account/config";
import { svettServer } from "../account/sync";
import type { RootNavigation } from "../navigation";
import { AppText } from "../ui/AppText";
import { EmptyState } from "../ui/EmptyState";

export type SocialResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

/** Runs a request and turns its failure into the sentence the screen shows. */
export const runSocial = async <A,>(
  request: Effect.Effect<A, SocialFailed>,
): Promise<SocialResult<A>> => {
  const exit = await Effect.runPromiseExit(request);
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return {
    ok: false,
    message:
      error instanceof SocialFailed ? socialProblemMessage(error) : "Something went wrong.",
  };
};

export type SocialState<A> =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly value: A };

/**
 * Reads from the svett server each time the screen comes into view, and on `reload`, such as
 * after a follow. Callers memoize `read`. An answer for a read the screen moved on from is
 * dropped.
 */
export function useSocialRead<A>(read: () => Effect.Effect<A, SocialFailed>) {
  const [state, setState] = useState<SocialState<A>>({ status: "loading" });
  const load = useCallback(() => {
    let current = true;
    void runSocial(read()).then((result) => {
      if (!current) return;
      setState(
        result.ok
          ? { status: "ready", value: result.value }
          : { status: "failed", message: result.message },
      );
    });
    return () => {
      current = false;
    };
  }, [read]);
  useFocusEffect(load);
  return { state, reload: load };
}

/** The screen's content once its read is ready, or what it shows while waiting or after a failure. */
export function SocialView<A>({
  state,
  testID,
  children,
}: {
  readonly state: SocialState<A>;
  readonly testID: string;
  readonly children: (value: A) => ReactNode;
}) {
  switch (state.status) {
    case "loading":
      return (
        <View testID={`${testID}-loading`} className="flex-1 items-center justify-center p-8">
          <AppText tone="secondary">Asking svett</AppText>
        </View>
      );
    case "failed":
      return (
        <View testID={`${testID}-failed`} className="flex-1 justify-center">
          <EmptyState
            symbol="exclamationmark.triangle"
            title="This did not load"
            message={state.message}
          />
        </View>
      );
    case "ready":
      return children(state.value);
  }
}

function Centered({ testID, children }: { readonly testID: string; readonly children: ReactNode }) {
  return (
    <ScrollView
      testID={testID}
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow justify-center py-8"
      contentInsetAdjustmentBehavior="automatic"
    >
      {children}
    </ScrollView>
  );
}

function SignedInApi({ children }: { readonly children: (api: SocialApi) => ReactNode }) {
  const navigation = useNavigation<RootNavigation>();
  const { isLoaded, userId, getToken } = useAuth();
  const api = useMemo(
    () => httpSocialApi({ server: svettServer(), token: () => getToken(), fetch }),
    [getToken],
  );
  if (!isLoaded) {
    return (
      <Centered testID="social-opening">
        <AppText tone="secondary" className="text-center">
          Opening your account
        </AppText>
      </Centered>
    );
  }
  if (!userId) {
    return (
      <Centered testID="social-signed-out">
        <EmptyState
          symbol="person.crop.circle.badge.questionmark"
          title="Sign in to use profiles"
          message="Profiles, search and follows need a svett account. Everything else works without one."
          action={{ label: "Open Account", onPress: () => navigation.navigate("Account") }}
        />
      </Centered>
    );
  }
  return children(api);
}

/** Gives `children` the social API for the signed-in account, or says why there is none. */
export function SignedInOnly({ children }: { readonly children: (api: SocialApi) => ReactNode }) {
  if (CLERK_PUBLISHABLE_KEY === undefined) {
    return (
      <Centered testID="social-accounts-off">
        <EmptyState
          symbol="person.crop.circle.badge.exclamationmark"
          title="Accounts are not set up"
          message="This build has no Clerk key, so it cannot sign in. Everything on the phone works without an account."
        />
      </Centered>
    );
  }
  return <SignedInApi>{children}</SignedInApi>;
}
