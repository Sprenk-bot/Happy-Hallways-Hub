import type {
  HubPromptResponseSnapshot,
  HubVisit,
  HubVisitAttribution,
  StaffAttribution,
} from './types';

export type HubMovementRow = {
  id: string;
  visitId: string;
  studentId: string;
  studentName: string;
  yearGroup: string;
  className: string;
  periodName: string;
  destination: string;
  occurredAt: string;
  event: string;
  staff: string;
  concern: boolean;
  detail: string;
};

export type HubStudentCheckInRow = { id: string; when: string; question: string; answer: string; destination: string };

/** Individual student check-ins for the TIC-only profile view. */
export function hubVisitRowsForStudent(visits: HubVisit[], studentId: string, since?: string): HubStudentCheckInRow[] {
  return visits.filter((visit) => visit.studentId === studentId).flatMap((visit) =>
    (visit.promptResponses ?? []).filter((response) => !since || response.answeredAt >= since).map((response) => ({
      id: `${visit.id}:${response.promptId}:${response.answeredAt}`,
      when: response.answeredAt,
      question: response.question,
      answer: String(response.answer),
      destination: visit.destinationLabel,
    })),
  ).sort((a, b) => b.when.localeCompare(a.when));
}

function actorName(actor: HubVisitAttribution | StaffAttribution | undefined) {
  if (!actor) return '';
  return 'type' in actor ? 'Student kiosk' : actor.displayName;
}

function csvCell(value: string | boolean) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function answerText(response: HubPromptResponseSnapshot) {
  const answer = String(response.answer).replaceAll(/\s+/g, ' ').trim();
  return `${response.question}: ${answer}`;
}

/** Builds an ordered event list from the saved visit timestamps without inventing times. */
export function hubMovementRows(visits: HubVisit[]): HubMovementRow[] {
  const rows: HubMovementRow[] = [];
  const add = (
    visit: HubVisit,
    id: string,
    occurredAt: string | undefined,
    event: string,
    staff: string,
    detail = '',
  ) => {
    if (!occurredAt) return;
    rows.push({
      id: `${visit.id}:${id}`,
      visitId: visit.id,
      studentId: visit.studentId,
      studentName: visit.studentName,
      yearGroup: visit.studentCategory?.name ?? '',
      className: visit.className ?? '',
      periodName: visit.periodName ?? '',
      destination: visit.destinationLabel,
      occurredAt,
      event,
      staff,
      concern: Boolean(visit.hasConcern),
      detail,
    });
  };

  for (const visit of visits) {
    add(visit, 'left-class', visit.leftClassAt, 'Left class', actorName(visit.notifiedBy));
    add(visit, 'arrived-hub', visit.arrivedAtHubAt, 'Arrived at Hub', actorName(visit.arrivedBy));
    for (const trip of visit.temporaryTrips ?? []) {
      add(visit, `trip-${trip.id}-start`, trip.startedAt, `Started temporary trip: ${trip.destinationLabel}`, actorName(trip.startedBy));
      add(visit, `trip-${trip.id}-return`, trip.returnedAt, `Returned from temporary trip: ${trip.destinationLabel}`, actorName(trip.returnedBy));
    }
    add(visit, 'left-hub', visit.leftHubAt, 'Left Hub', actorName(visit.leftBy));
    add(visit, 'returned-class', visit.arrivedBackAtClassAt, 'Arrived back in class', actorName(visit.returnedBy));
    add(
      visit,
      'cancelled',
      visit.cancelledAt,
      visit.cancellationReason === 'did-not-arrive' ? 'Did not arrive' : 'Notification withdrawn',
      actorName(visit.cancelledBy),
    );
    for (const response of visit.promptResponses ?? []) {
      add(
        visit,
        `prompt-${response.promptId}-${response.answeredAt}`,
        response.answeredAt,
        response.stage === 'arrival' ? 'Arrival check-in' : 'Departure check-in',
        'Student kiosk',
        answerText(response),
      );
    }
    for (const override of visit.promptOverrides ?? []) {
      add(
        visit,
        `override-${override.overrideId}`,
        override.appliedAt,
        `${override.stage === 'arrival' ? 'Arrival' : 'Departure'} question override`,
        override.requestedBy.displayName,
        override.usedToSkip ? 'Used to skip a required question' : 'Issued but not used to skip a question',
      );
    }
  }

  return rows.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
}

/** Export only the selected timeline rows. Concern notes remain in the Mail Centre. */
export function hubMovementRowsToCsv(rows: HubMovementRow[]) {
  const headings = ['Time', 'Student', 'Year group', 'Event', 'Destination', 'Class', 'Period', 'Staff member', 'Concern recorded', 'Check-in or override detail'];
  const lines = [...rows]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))
    .map((row) => [
      row.occurredAt,
      row.studentName,
      row.yearGroup,
      row.event,
      row.destination,
      row.className,
      row.periodName,
      row.staff,
      row.concern ? 'Yes' : '',
      row.detail,
    ]);
  return [headings, ...lines].map((line) => line.map(csvCell).join(',')).join('\n');
}

/** One row per visit with the timestamps staff need for end-of-day reporting. */
export function hubVisitSummaryRowsToCsv(visits: HubVisit[], staffName: (id: string, fallback: string) => string = (_id, fallback) => fallback) {
  const headings = ['Student', 'Year group', 'Destination', 'Class', 'Period', 'Left class at', 'Arrived at Hub', 'Left Hub', 'Returned to class', 'Concern recorded', 'Student question responses', 'Hub staff note'];
  const rows = visits.map((visit) => [
    staffName(visit.studentId, visit.studentName),
    visit.studentCategory?.name ?? '',
    visit.destinationLabel,
    visit.className ?? '',
    visit.periodName ?? '',
    visit.leftClassAt ?? '',
    visit.arrivedAtHubAt ?? '',
    visit.leftHubAt ?? '',
    visit.arrivedBackAtClassAt ?? '',
    visit.hasConcern ? 'Yes' : '',
    (visit.promptResponses ?? []).map(answerText).join(' | '),
    visit.hubStaffNote ?? '',
  ]);
  return [headings, ...rows].map((line) => line.map(csvCell).join(',')).join('\n');
}
