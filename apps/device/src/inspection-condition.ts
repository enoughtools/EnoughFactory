export interface ObservedCondition {
  labelIncludes: string;
  valueIncludes?: string;
  valueEquals?: string;
  absent?: boolean;
}

export function evaluateObservedCondition(
  elements: readonly { label?: string; identifier?: string; value?: string }[],
  condition: ObservedCondition,
): boolean {
  if (typeof condition.labelIncludes !== 'string' || !condition.labelIncludes.trim()) {
    throw new Error('An assertion needs a concrete observed label.');
  }
  if (condition.valueIncludes !== undefined && typeof condition.valueIncludes !== 'string'
    || condition.valueEquals !== undefined && typeof condition.valueEquals !== 'string') {
    throw new Error('Assertion values must be text.');
  }
  const matchesLabel = (element: (typeof elements)[number]) => (element.label || element.identifier || '').includes(condition.labelIncludes);
  if (condition.absent === true) return !elements.some(matchesLabel);
  return elements.some(element => matchesLabel(element)
    && (condition.valueIncludes === undefined || (element.value || '').includes(condition.valueIncludes))
    && (condition.valueEquals === undefined || typeof element.value === 'string' && element.value === condition.valueEquals));
}
