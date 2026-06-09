export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 60 * 60 * 1000);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

export function computeUnassignedMessageSlaDue(receivedAt: Date): Date {
  return addHours(receivedAt, 2);
}

export function computeUnackTaskSlaDue(assignedAt: Date): Date {
  return addHours(assignedAt, 2);
}

export function computeReadyDraftSlaDue(readyAt: Date): Date {
  return addDays(readyAt, 1);
}

export function computeParentNotFullyRepliedDue(receivedAt: Date): Date {
  return addDays(receivedAt, 2);
}

