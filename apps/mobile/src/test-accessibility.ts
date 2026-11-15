import type { ReactTestInstance } from "react-test-renderer";

const is = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;

const text = (value: unknown) => typeof value === "string" && value.trim() !== "";

// A class that gives a control the 44 point target, or the larger one controls used mid-set get.
const TARGET = /(^|\s)(min-h|h|size)-(target|key)(\s|$)/;

const where = (node: ReactTestInstance) =>
  text(node.props.testID)
    ? `#${node.props.testID}`
    : text(node.props.accessibilityLabel)
      ? `"${node.props.accessibilityLabel}"`
      : `a ${String(node.type)} under ${describeParent(node)}`;

/**
 * The control's own class, or that of the view it wraps alone, as ListRow's rows and the glass
 * of the workout bar do.
 */
const hasTarget = (node: ReactTestInstance): boolean => {
  if (node.props.hitSlop !== undefined || TARGET.test(String(node.props.className ?? ""))) {
    return true;
  }
  const inner = node.children.filter(
    (child): child is ReactTestInstance => typeof child !== "string",
  );
  const only = inner.length === 1 ? inner[0] : undefined;
  return only !== undefined && hasTarget(only);
};

/** VoiceOver skips what sits under a view hidden from it, such as a row's own switch. */
const hidden = (node: ReactTestInstance) => {
  for (let each: ReactTestInstance | null = node; each; each = each.parent) {
    if (each.props.accessibilityElementsHidden === true) return true;
  }
  return false;
};

const labelled = (node: ReactTestInstance) => {
  for (let each: ReactTestInstance | null = node; each; each = each.parent) {
    if (text(each.props.accessibilityLabel)) return true;
  }
  return false;
};

const describeParent = (node: ReactTestInstance): string => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (text(parent.props.testID)) return `#${parent.props.testID}`;
  }
  return "the screen";
};

/**
 * What VoiceOver could not use on the drawn screen: a pressable without a role, a label or a
 * 44 point target, a switch or text field without a label, and an SF Symbol that is neither
 * labelled nor hidden. Each problem names the control by its test ID or label.
 */
export const unlabelledControls = (root: ReactTestInstance): ReadonlyArray<string> =>
  root
    .findAll((node) => typeof node.type === "string" && !hidden(node))
    .flatMap((node) => {
      const problems: Array<string> = [];
      if (is(node, "Pressable")) {
        if (!text(node.props.accessibilityRole)) problems.push(`${where(node)} has no role`);
        if (!text(node.props.accessibilityLabel)) problems.push(`${where(node)} has no label`);
        if (!hasTarget(node)) problems.push(`${where(node)} has no 44 point target`);
      }
      if ((is(node, "Switch") || is(node, "TextInput")) && !text(node.props.accessibilityLabel)) {
        problems.push(`${where(node)} has no label`);
      }
      if (is(node, "SymbolView") && !text(node.props.accessibilityLabel)) {
        problems.push(
          `the symbol ${String(node.props.name)} under ${describeParent(node)} is neither labelled nor hidden`,
        );
      }
      // A chart or a map is one image to VoiceOver, read out by the view that holds it.
      if ((is(node, "Svg") || is(node, "AppleMapsView")) && !labelled(node)) {
        problems.push(`a ${String(node.type)} under ${describeParent(node)} has no text summary`);
      }
      return problems;
    });
