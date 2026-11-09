const SIZE_PROPERTIES = new Set(["height", "maxHeight", "minHeight", "blockSize", "gridTemplateRows"])

/** A height animation is running somewhere in the element, so its size is not final. */
export function isAnimatingSize(element: Element): boolean {
  if (typeof element.getAnimations !== "function") return false
  return element.getAnimations({ subtree: true }).some((animation) => {
    if (animation.playState !== "running") return false
    const effect = animation.effect
    if (!(effect instanceof KeyframeEffect)) return false
    return effect.getKeyframes().some((frame) => Object.keys(frame).some((property) => SIZE_PROPERTIES.has(property)))
  })
}
