<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    account,
    activeClassLabel,
    classStudents,
    currentSchedule,
    cancelHubVisitNotification,
    confirmArrivedBackAtClass,
    createClass,
    findClass,
    findSchedule,
    liveSchedule,
    leaveHub,
    markReturned,
    notifyHubVisit,
    moveWarning,
    noPassNow,
    openPasses,
    recordHubArrival,
    removeKiosk,
    passStatus,
    passStatusIcon,
    passStatusText,
    setActiveClass,
    staffStudentName,
    setDoorLocked,
    stopFollowingSchedule,
    useSchedule,
    useThisComputer,
    useWarning,
    hubVisitStatus,
  } from '#lib/account.svelte.ts';
  import { clock } from '#lib/clock.svelte.ts';
  import { playHubChime, prepareHubAudio } from '../../lib/sound';
  import ConfirmDialog from '#lib/ConfirmDialog.svelte';
  import DestinationIcon from '#lib/DestinationIcon.svelte';
  import Icon from '#lib/Icon.svelte';
  import MenuSelect from '#lib/MenuSelect.svelte';
  import { cancelPairing, kioskOnline, kioskState, refreshLink } from '#lib/link.svelte.ts';
  import PairingDialog from '#lib/PairingDialog.svelte';
  import PassMarks from '#lib/PassMarks.svelte';
  import QuietScene, { seasons, type Season } from '#lib/QuietScene.svelte';
  import { page } from '$app/state';
  import { currentRoom, devicesText, studentLink, studentLinkUrl } from '#lib/studentLink.svelte.ts';
  import {
    clearStaffPreferences,
    loadStaffPreferences,
    staffPreferences,
    toggleFavouriteStudent,
  } from '#lib/staff-preferences.svelte.ts';
  import RoomBoard from '#lib/RoomBoard.svelte';
  import StartPassDialog from '#lib/StartPassDialog.svelte';
  import { perform, startPassFromHome } from '#lib/door.svelte.ts';
  import RoomCode from '#lib/RoomCode.svelte';
  import { popOutRoom } from '#lib/popOut.ts';
  import type { HubVisitCancellationReason } from '#lib/types.ts';
  import { duration, hasRealDuration, isOverdue, now, time } from '#lib/passes.ts';
  import { nextClassPeriod, periodAt, toMinutes } from '#lib/schedule.ts';
  import { flushHubSaves, hubRuntime, reloadFromHost } from '#lib/hub-runtime.svelte.ts';
  import { hubMail, loadMailRecipients, sendHubConcern } from '#lib/hub-mail.svelte.ts';

  /**
   * Home: the one page a teacher keeps open all day. The day and whether
   * students may leave come first; then the class on the kiosk, what's
   * happening in it, and students' Requests down the side. See CONTEXT.md.
   */
  let name = $state('');
  /** `?season=winter` shows that season's scene, to preview it. Otherwise it follows the date. */
  const season = $derived(seasons.find((each) => each === page.url.searchParams.get('season')) as Season | undefined);

  const at = $derived(clock.now);
  const classId = $derived(account.activeClass?.id ?? null);
  const classRoster = $derived(
    classStudents(findClass(classId)).filter((student) => student.status === 'current'),
  );
  const filteredHubStudents = $derived.by(() => {
    const query = hubStudentSearch.trim().toLocaleLowerCase();
    return classRoster.filter((student) => {
      if (hubYearGroup === 'unassigned' && student.categoryId) return false;
      if (hubYearGroup && hubYearGroup !== 'unassigned' && student.categoryId !== hubYearGroup) return false;
      const category = account.studentCategories.find((each) => each.id === student.categoryId)?.name ?? '';
      const name = `${student.firstName} ${student.lastName ?? student.lastPrefix}`.toLocaleLowerCase();
      return !query || name.includes(query) || category.toLocaleLowerCase().includes(query);
    });
  });
  const favouriteHubStudents = $derived(
    filteredHubStudents.filter((student) => staffPreferences.favouriteStudentIds.includes(student.id)),
  );
  const otherHubStudents = $derived(
    filteredHubStudents.filter((student) => !staffPreferences.favouriteStudentIds.includes(student.id)),
  );
  const selectedHubStudent = $derived(classRoster.find((student) => student.id === hubStudentId) ?? null);
  const selectedHubStudentIsFavourite = $derived(
    !!selectedHubStudent && staffPreferences.favouriteStudentIds.includes(selectedHubStudent.id),
  );
  const hubDestinations = $derived(account.destinations.filter((destination) => destination.informHubAvailable));
  const currentHubVisits = $derived(
    account.hubVisits
      .filter(
        (visit) =>
          !visit.arrivedBackAtClassAt &&
          (!visit.cancelledAt || visit.classId === classId),
      )
      .sort((a, b) =>
        (b.leftClassAt ?? b.arrivedAtHubAt ?? '').localeCompare(
          a.leftClassAt ?? a.arrivedAtHubAt ?? '',
        ),
      ),
  );
  const live = $derived(liveSchedule());
  const status = $derived(passStatus(at));
  const noPass = $derived(classId ? noPassNow(classId, at) : null);
  const tone = $derived({ open: 'ok', 'no-pass': 'warn', between: '', 'no-class': '' }[status]);

  /** "22 min", or "1 hr 5 min", until a clock time today. */
  function until(clockTime: string) {
    const nowDate = new Date(at);
    const minutes = Math.max(1, toMinutes(clockTime) - (nowDate.getHours() * 60 + nowDate.getMinutes()));
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  }

  /** The second line: when this changes next, in words. */
  const timing = $derived.by(() => {
    if (!classId && account.activeClass?.onSchedule) {
      const upcoming = nextClassPeriod(live, at);
      const cls = findClass(upcoming?.classId);
      return upcoming && cls ? `${cls.name} starts in ${until(upcoming.start)}` : 'No more classes today';
    }
    if (!classId) return 'Choose a class to put on the kiosk';
    if (noPass) return noPass.end ? `Passes open in ${until(noPass.end)}` : 'Passes stay closed until you open them';
    const period = live ? periodAt(live, at) : null;
    // Off schedule nothing changes by itself, so there's nothing to say; the schedule menu says it's off.
    return period ? `Ends in ${until(period.end)}` : '';
  });

  const out = $derived(classId ? openPasses(classId).sort((a, b) => a.outAt.localeCompare(b.outAt)) : []);
  const waiting = $derived(account.line.filter((spot) => spot.classId === classId));
  /** Each destination has its own line; under a Class Limit there is one Class Line, named by no destination. */
  const lines = $derived(
    account.limitMode === 'class'
      ? [{ destination: null, spots: waiting }].filter((each) => each.spots.length)
      : [...new Set(waiting.map((spot) => spot.destination))].map((destination) => ({
          destination: destination as string | null,
          spots: waiting.filter((spot) => spot.destination === destination),
        })),
  );

  /** "This class" starts when it came on the kiosk, or this morning if that was before today. */
  const since = $derived.by(() => {
    const changed = account.activeClass?.changedAt;
    const midnight = new Date(at);
    midnight.setHours(0, 0, 0, 0);
    return changed && changed > midnight.toISOString() ? changed : midnight.toISOString();
  });
  const thisClass = $derived(
    account.passes.filter((pass) => pass.classId === classId && pass.outAt >= since && pass.endedBy !== 'cancelled'),
  );
  const classOptions = $derived([
    ...(classId ? [] : [{ value: '', label: activeClassLabel(), disabled: true }]),
    ...account.classes.map((cls) => ({ value: cls.id, label: cls.name })),
  ]);
  const scheduleOptions = $derived([
    ...account.schedules.map((schedule) => ({
      value: schedule.id,
      label: schedule.name,
      disabled: !schedule.periods.length,
      hint: schedule.periods.length ? undefined : 'Add a period first',
    })),
    {
      value: '',
      label: account.schedules.length ? 'Off schedule' : 'No schedule',
      hint: 'You choose the class by hand',
    },
  ]);

  type Activity = { id: string; at: string; text: string; pass?: (typeof account.passes)[number]; denied?: boolean };
  /** What has happened in this class so far, newest first. */
  const activity = $derived.by(() => {
    const events: Activity[] = [];
    for (const pass of thisClass) {
      events.push({ id: `${pass.id}-out`, at: pass.outAt, text: `${staffStudentName(pass.studentId, pass.studentName)} left for ${pass.destination}`, pass });
      if (pass.inAt && pass.endedBy === 'student') {
        const minutes = hasRealDuration(pass) ? ` after ${duration(pass)} min` : '';
        events.push({ id: `${pass.id}-in`, at: pass.inAt, text: `${staffStudentName(pass.studentId, pass.studentName)} came back${minutes}` });
      }
      if (pass.inAt && pass.endedBy === 'teacher') {
        events.push({ id: `${pass.id}-in`, at: pass.inAt, text: `You marked ${staffStudentName(pass.studentId, pass.studentName)} back` });
      }
    }
    for (const request of account.deniedRequests) {
      if (request.classId !== classId || request.deniedAt < since) continue;
      events.push({
        id: request.id,
        at: request.deniedAt,
        text: `You said no to ${staffStudentName(request.studentId, request.studentName)} (${request.destination})`,
        denied: true,
      });
    }
    return events.sort((a, b) => b.at.localeCompare(a.at));
  });

  /** A change that needs the teacher's OK first: taking the kiosk off schedule, or ending passes. */
  let confirming = $state(null as null | { title: string; message: string; label: string; run: () => void });

  function chooseClass(id: string) {
    if (id === classId) return;
    const cls = findClass(id);
    const move = () => setActiveClass({ id, changedAt: now() });
    const warning = moveWarning(id);
    if (!warning) return move();
    confirming = {
      title: live ? `You're on ${live.name}. Switch to ${cls?.name} by hand?` : `Switch the kiosk to ${cls?.name}?`,
      message: warning,
      label: 'Switch class',
      run: move,
    };
  }

  function chooseSchedule(id: string) {
    if (!id) return stopFollowingSchedule();
    const warning = useWarning(id);
    if (!warning) return useSchedule(id);
    confirming = { title: `Use ${findSchedule(id)?.name}?`, message: warning, label: 'Use this schedule', run: () => useSchedule(id) };
  }

  function create(event: SubmitEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    goto(`/classes/${createClass(name.trim())}?add`);
  }

  const kiosk = $derived(kioskState());
  let pairing = $state(false);

  /** Reconnecting is pairing again with a code, on the same kiosk. */
  let reconnecting = $state(false);

  function thisComputer() {
    pairing = false;
    cancelPairing();
    useThisComputer();
    refreshLink();
  }

  function disconnect() {
    confirming = {
      title: account.kiosk?.kind === 'device' ? 'Disconnect the kiosk?' : 'Stop using this computer as the kiosk?',
      message:
        account.kiosk?.kind === 'device'
          ? "Students won't be able to take a pass on it. If it's holding passes this computer hasn't received yet, they'll still arrive the next time it connects."
          : "Students won't be able to take a pass until you set up a kiosk again.",
      label: 'Disconnect',
      run: () => {
        cancelPairing();
        removeKiosk();
        refreshLink();
      },
    };
  }

  function openDoor() {
    setDoorLocked(true);
    goto('/door');
  }

  const today = $derived(
    new Intl.DateTimeFormat([], { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(at)),
  );

  /**
   * Managing the Line from here: the teacher's computer keeps it (docs/adr/0014), so adding,
   * removing and clearing go through the same rules as the kiosk's taps.
   */
  const quiet = () => {};
  let startingPass = $state(false);
  let hubStudentId = $state('');
  let hubStudentSearch = $state('');
  let hubYearGroup = $state('');
  let hubDestinationId = $state('');
  let hubConcernChoice = $state<'no-concerns' | 'concern'>('no-concerns');
  let hubConcernNote = $state('');
  let hubConcernScope = $state<'tic' | 'all-staff' | 'selected'>('tic');
  let hubConcernRecipientIds = $state<string[]>([]);
  let pendingConcern = $state<{
    visitId: string;
    note: string;
    scope: 'tic' | 'all-staff' | 'selected';
    recipientIds: string[];
  } | null>(null);
  let hubNoticeState = $state<'idle' | 'saving' | 'saved' | 'pending' | 'error'>('idle');
  let extendingHubTimerId = $state('');
  let savingHubNoteId = $state('');
  let hubStaffNoteDrafts = $state<Record<string, string>>({});
  let hubNoticeMessage = $state('');
  let pendingHubSuccessMessage = '';

  $effect(() => {
    if (!hubRuntime.hosted || (hubRuntime.session && ['ready', 'no-data'].includes(hubRuntime.status))) {
      void loadStaffPreferences();
    } else if (hubRuntime.status === 'signed-out') {
      clearStaffPreferences();
    }
  });

  let recipientsLoadedFor = '';
  $effect(() => {
    const staffId = hubRuntime.session?.staffId ?? '';
    if (hubRuntime.hosted && hubRuntime.status === 'ready' && staffId && recipientsLoadedFor !== staffId) {
      recipientsLoadedFor = staffId;
      void loadMailRecipients();
    } else if (hubRuntime.status === 'signed-out') {
      recipientsLoadedFor = '';
    }
  });

  let appliedConcernPolicyAt = '';
  $effect(() => {
    const policy = hubMail.concernPolicy;
    if (hubMail.concernPolicyLoaded && policy.updatedAt !== appliedConcernPolicyAt) {
      appliedConcernPolicyAt = policy.updatedAt;
      hubConcernScope = policy.defaultScope;
    }
  });

  $effect(() => {
    if (hubStudentId && !filteredHubStudents.some((student) => student.id === hubStudentId)) {
      hubStudentId = '';
    }
  });

  $effect(() => {
    if (
      hubNoticeState === 'pending' &&
      hubRuntime.hosted &&
      hubRuntime.status === 'ready' &&
      hubRuntime.saveStatus === 'saved'
    ) {
      hubNoticeState = 'saved';
      hubNoticeMessage = pendingHubSuccessMessage;
      pendingHubSuccessMessage = '';
    }
  });

  async function informHub(event: SubmitEvent) {
    event.preventDefault();
    if (hubNoticeState === 'saving') return;

    if (pendingConcern) {
      await deliverPendingConcern();
      return;
    }
    if (!classId) return;

    const cls = findClass(classId);
    const student = classRoster.find((each) => each.id === hubStudentId);
    if (!cls || !student || !hubDestinations.some((each) => each.id === hubDestinationId)) {
      hubNoticeState = 'error';
      hubNoticeMessage = 'Choose a current student and an enabled destination.';
      return;
    }

    const concern = hubConcernChoice === 'concern';
    if (concern) {
      if (!hubRuntime.hosted || !hubRuntime.session) {
        hubNoticeState = 'error';
        hubNoticeMessage = 'Connect to the Hub Host before sending a private concern note.';
        return;
      }
      if (!hubConcernNote.trim() || hubConcernNote.length > 2000) {
        hubNoticeState = 'error';
        hubNoticeMessage = 'Enter a concern note of up to 2000 characters.';
        return;
      }
      if (hubConcernScope === 'selected' && !hubConcernRecipientIds.length) {
        hubNoticeState = 'error';
        hubNoticeMessage = 'Choose at least one staff member to receive this concern.';
        return;
      }
    }

    try {
      const visitId = notifyHubVisit({
        studentId: student.id,
        destinationId: hubDestinationId,
        classId: cls.id,
        className: cls.name,
        ...(periodAt(currentSchedule()) ? { periodName: `${periodAt(currentSchedule())!.start}–${periodAt(currentSchedule())!.end}` } : {}),
        ...(concern ? { hasConcern: true } : {}),
      });
      if (concern) {
        pendingConcern = {
          visitId,
          note: hubConcernNote.trim(),
          scope: hubConcernScope,
          recipientIds: hubConcernScope === 'selected' ? [...hubConcernRecipientIds] : [],
        };
      }
      const saved = await waitForHubSave(
        hubRuntime.hosted ? 'Saved to the Hub Host.' : 'Notification saved on this computer.',
      );
      if (saved && pendingConcern) await deliverPendingConcern();
    } catch (error) {
      hubNoticeState = 'error';
      hubNoticeMessage = error instanceof Error ? error.message : 'The notification could not be saved.';
    }
  }

  async function deliverPendingConcern() {
    if (!pendingConcern) return;
    if (!hubMail.concernPolicyLoaded || hubMail.concernPolicyError) {
      hubNoticeState = 'error';
      hubNoticeMessage = hubMail.concernPolicyError || 'Concern routing settings are not confirmed by the Hub Host.';
      return;
    }
    if (!hubConcernNote.trim() || hubConcernNote.length > 2000) {
      hubNoticeState = 'error';
      hubNoticeMessage = 'Enter a concern note of up to 2000 characters.';
      return;
    }
    if (
      !hubMail.concernPolicy.availableScopes.includes(hubConcernScope) ||
      (hubConcernScope === 'selected' && !hubConcernRecipientIds.length)
    ) {
      hubNoticeState = 'error';
      hubNoticeMessage = 'Choose a route and any required recipients allowed by the current TIC policy.';
      return;
    }

    const concern = {
      ...pendingConcern,
      note: hubConcernNote.trim(),
      scope: hubConcernScope,
      recipientIds: hubConcernScope === 'selected' ? [...hubConcernRecipientIds] : [],
    };
    const saved = await flushHubSaves();
    if (!saved) {
      hubNoticeState = hubRuntime.status === 'conflict' || hubRuntime.saveStatus === 'forbidden' ? 'error' : 'pending';
      hubNoticeMessage = hubRuntime.message || 'The movement is not yet confirmed by the Hub Host. The concern note has not been sent; retry after reconnecting.';
      return;
    }

    hubNoticeState = 'saving';
    hubNoticeMessage = '';
    try {
      const savedMessage = await sendHubConcern(concern);
      const recipientsMatch =
        concern.scope !== 'selected' ||
        (savedMessage.recipients.length === concern.recipientIds.length &&
          concern.recipientIds.every((staffId) =>
            savedMessage.recipients.some((recipient) => recipient.staffId === staffId),
          ));
      if (
        savedMessage.note !== concern.note ||
        savedMessage.scope !== concern.scope ||
        !recipientsMatch
      ) {
        throw new Error('A concern for this movement was already saved with its original note and recipients. Check the Mail Centre before retrying.');
      }
      pendingConcern = null;
      hubConcernChoice = 'no-concerns';
      hubConcernNote = '';
      hubConcernRecipientIds = [];
      hubNoticeState = 'saved';
      hubNoticeMessage = 'The movement and private concern note were saved to the Hub Host.';
    } catch (error) {
      hubNoticeState = 'error';
      hubNoticeMessage = error instanceof Error
        ? `The movement was saved, but its concern note was not confirmed. Retry concern delivery: ${error.message}`
        : 'The movement was saved, but its concern note was not confirmed. Retry concern delivery.';
    }
  }

  async function confirmHubReturn(visitId: string) {
    if (hubNoticeState === 'saving') return;
    prepareHubAudio();
    try {
      confirmArrivedBackAtClass(visitId);
      const acknowledged = await waitForHubSave(
        hubRuntime.hosted ? 'Return confirmation saved to the Hub Host.' : 'Return confirmation saved on this computer.',
      );
      const settings = account.hubKioskSoundSettings;
      if (acknowledged && settings && !settings.muted) {
        playHubChime(settings.commonChime, settings.volume);
      }
    } catch (error) {
      hubNoticeState = 'error';
      hubNoticeMessage = error instanceof Error ? error.message : 'The return confirmation could not be saved.';
    }
  }

  async function confirmHubArrival(visitId: string) {
    if (hubNoticeState === 'saving') return;
    try {
      recordHubArrival(visitId);
      await waitForHubSave(
        hubRuntime.hosted
          ? 'Hub arrival saved to the Hub Host.'
          : 'Hub arrival saved on this computer.',
      );
    } catch (error) {
      hubNoticeState = 'error';
      hubNoticeMessage = error instanceof Error
        ? error.message
        : 'The Hub arrival could not be saved.';
    }
  }

  async function addHubVisitTime(visitId: string, minutes = 5) {
    if (extendingHubTimerId || !hubRuntime.hosted || hubRuntime.status !== 'ready') return;
    extendingHubTimerId = visitId;
    hubNoticeMessage = '';
    try {
      const response = await fetch(`/api/v1/hub-visits/${encodeURIComponent(visitId)}/time`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes }),
      });
      if (!response.ok) throw new Error('The Host did not add time to this visit.');
      await reloadFromHost();
      hubNoticeMessage = `${minutes} minutes added to the Hub timer.`;
    } catch (problem) {
      hubNoticeMessage = problem instanceof Error ? problem.message : 'Could not add time to the Hub timer.';
    } finally {
      extendingHubTimerId = '';
    }
  }

  async function saveHubStaffNote(visitId: string) {
    if (savingHubNoteId || !hubRuntime.hosted || hubRuntime.status !== 'ready') return;
    savingHubNoteId = visitId;
    hubNoticeMessage = '';
    try {
      const response = await fetch(`/api/v1/hub-visits/${encodeURIComponent(visitId)}/note`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: hubStaffNoteDrafts[visitId] ?? '' }),
      });
      if (!response.ok) throw new Error('The Hub Host did not save the note.');
      await reloadFromHost();
      hubNoticeMessage = 'Hub staff note saved.';
    } catch (problem) {
      hubNoticeMessage = problem instanceof Error ? problem.message : 'The Hub staff note could not be saved.';
    } finally {
      savingHubNoteId = '';
    }
  }

  async function confirmHubDeparture(visitId: string) {
    if (hubNoticeState === 'saving') return;
    try {
      leaveHub(visitId);
      await waitForHubSave(
        hubRuntime.hosted
          ? 'Hub departure saved to the Hub Host.'
          : 'Hub departure saved on this computer.',
      );
    } catch (error) {
      hubNoticeState = 'error';
      hubNoticeMessage = error instanceof Error
        ? error.message
        : 'The Hub departure could not be saved.';
    }
  }

  function requestHubDeparture(visitId: string) {
    confirming = {
      title: 'Confirm the student has left the Hub?',
      message: 'This closes the Main Hub Visit. It does not confirm that the student has returned to class.',
      label: 'Confirm left Hub',
      run: () => void confirmHubDeparture(visitId),
    };
  }

  async function cancelHubMovement(
    visitId: string,
    reason: HubVisitCancellationReason,
  ) {
    if (hubNoticeState === 'saving') return;
    try {
      cancelHubVisitNotification(visitId, reason);
      await waitForHubSave(
        hubRuntime.hosted
          ? 'Hub notification cancellation saved to the Hub Host.'
          : 'Hub notification cancellation saved on this computer.',
      );
    } catch (error) {
      hubNoticeState = 'error';
      hubNoticeMessage = error instanceof Error
        ? error.message
        : 'The Hub notification could not be cancelled.';
    }
  }

  function requestHubMovementCancellation(
    visitId: string,
    reason: HubVisitCancellationReason,
  ) {
    const didNotArrive = reason === 'did-not-arrive';
    confirming = {
      title: didNotArrive ? 'Mark as did not arrive?' : 'Cancel this notification?',
      message: didNotArrive
        ? 'This closes the classroom notification without recording an arrival or completed visit. The movement remains in History.'
        : 'This withdraws the classroom notification without recording an arrival or completed visit. The movement remains in History.',
      label: didNotArrive ? 'Mark did not arrive' : 'Cancel notification',
      run: () => void cancelHubMovement(visitId, reason),
    };
  }

  async function waitForHubSave(successMessage: string) {
    pendingHubSuccessMessage = '';
    hubNoticeState = 'saving';
    hubNoticeMessage = '';
    const acknowledged = await flushHubSaves();
    if (acknowledged) {
      hubNoticeState = 'saved';
      hubNoticeMessage = successMessage;
    } else if (hubRuntime.status === 'conflict' || hubRuntime.saveStatus === 'forbidden') {
      hubNoticeState = 'error';
      hubNoticeMessage = hubRuntime.message || 'The Hub Host did not accept this action.';
    } else {
      hubNoticeState = 'pending';
      pendingHubSuccessMessage = successMessage;
      hubNoticeMessage = 'Pending: the Hub Host has not confirmed this action. Reconnect before relying on it.';
    }
    return acknowledged;
  }

  function hubStatusText(visit: (typeof account.hubVisits)[number]) {
    const status = hubVisitStatus(visit);
    if (status === 'on-the-way') return 'On the way to the Hub';
    if (status === 'at-hub') return 'At the Hub';
    if (status === 'on-temporary-trip') return 'On a Temporary Trip';
    if (status === 'cancelled') return 'Notification withdrawn';
    if (status === 'did-not-arrive') return 'Did not arrive';
    if (status === 'returned-to-class') return 'Returned to class';
    return 'Left the Hub; return to class not confirmed';
  }

  function needsPeriodTransitionReview(visit: (typeof account.hubVisits)[number]) {
    return (
      !visit.arrivedBackAtClassAt &&
      !visit.cancelledAt &&
      !!visit.classId &&
      visit.classId !== classId
    );
  }

  function removeFromLine(studentId: string) {
    perform({ kind: 'leave', studentId }, quiet);
  }

  function clearOneLine(spots: { studentId: string }[]) {
    for (const spot of spots) perform({ kind: 'leave', studentId: spot.studentId }, quiet);
  }

  /** The join link with the code already in it, to paste into Google Classroom or a chat. */
  let copied = $state(false);
  async function copyJoinLink() {
    try {
      await navigator.clipboard.writeText(studentLinkUrl());
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // Copying needs a secure page in some browsers; the Student devices page shows the link to copy by hand.
    }
  }

  /** The Room code full screen on this computer (say, on the projector), until Escape. It's always here, just hidden. */
  let board = $state<HTMLDivElement | null>(null);
</script>

{#if !account.classes.length}
  <div class="page">
    <header class="page-head">
      <div>
        <p class="eyebrow">Welcome to Happy Hallways</p>
        <h1>Start with your first class</h1>
        <p class="muted">
          Happy Hallways keeps track of who is out of your room, where they went and for how long. Everything stays on this
          computer. There's nothing to sign up for.
        </p>
      </div>
    </header>

    <form class="card" onsubmit={create}>
      <label class="field">
        Class name
        <input bind:value={name} placeholder="Period 1 · Math" />
      </label>
      <div class="row">
        <button class="btn btn-primary" disabled={!name.trim()}><Icon name="plus" size={16} />Create class</button>
      </div>
    </form>

    <p class="muted small">
      Is this the tablet or Chromebook by the door? <a href="/door">Make this device the kiosk</a>.
    </p>
  </div>
{:else}
  <div class="home">
    <div class="home-main">
      <header class="home-head">
        <div class="title-row">
          <h1>{today}</h1>
          <span class="badge status-badge {tone}" role="status"><Icon name={passStatusIcon[status]} size={15} />{passStatusText[status]}</span>
          <span class="schedule-menu">
            <MenuSelect label="Schedule" icon="calendar" value={live?.id ?? ''} options={scheduleOptions} onchoose={chooseSchedule} />
          </span>
        </div>
        <div class="context-row">
          <MenuSelect label="Class on the kiosk" value={classId ?? ''} options={classOptions} onchoose={chooseClass} />
          {#if timing}<span class="timing">{timing}</span>{/if}
        </div>
      </header>

      {#if classId}
        <section class="stats this-class" aria-label="Right now">
          <div class="stat"><strong>{out.length}</strong><span>Out of class now</span></div>
          <div class="stat"><strong>{waiting.length}</strong><span>Waiting in line</span></div>
        </section>

        <section class="card">
          <div class="right-now-head">
            <h2>Right now</h2>
            <button class="btn btn-small btn-primary" onclick={() => (startingPass = true)}><Icon name="plus" size={14} />Start a pass</button>
          </div>
          {#if !out.length && !lines.length}<p class="muted">Everyone's in class.</p>{/if}
          {#if out.length}
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>Student</th><th>Where</th><th>Left</th><th>Minutes</th><th></th></tr>
                </thead>
                <tbody>
                  {#each out as pass (pass.id)}
                    {@const late = isOverdue(pass, at)}
                    <tr>
                      <td><span class="who"><strong>{staffStudentName(pass.studentId, pass.studentName)}</strong> <PassMarks {pass} compact /></span></td>
                      <td><span class="destination-chip"><DestinationIcon label={pass.destination} size={24} />{pass.destination}</span></td>
                      <td class="nowrap">{time(pass.outAt)}</td>
                      <td class="nowrap">
                        <span class="minutes" class:late title={late ? 'Overdue' : undefined}>
                          {#if pass.minutes}
                            {@const share = Math.min(duration(pass, at) / pass.minutes, 1)}
                            <svg class="pie" viewBox="0 0 20 20" aria-hidden="true">
                              <circle cx="10" cy="10" r="9" />
                              {#if share >= 1}
                                <circle class="slice" cx="10" cy="10" r="9" />
                              {:else}
                                <path
                                  class="slice"
                                  d="M10 10 L10 1 A9 9 0 {share > 0.5 ? 1 : 0} 1 {10 + 9 * Math.sin(share * 2 * Math.PI)} {10 - 9 * Math.cos(share * 2 * Math.PI)} Z"
                                />
                              {/if}
                            </svg>
                            {duration(pass, at)} of {pass.minutes} min{#if late}<span class="sr-only"> (overdue)</span>{/if}
                          {:else}
                            {duration(pass, at)} min
                          {/if}
                        </span>
                      </td>
                      <td class="num">
                        <button class="btn btn-small" onclick={() => markReturned(pass.id)}>
                          <Icon name="check" size={14} />Mark back
                        </button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
          {#each lines as each (each.destination)}
            <div class="stack" style="gap:8px">
              <div class="line-head">
                <p class="eyebrow">{each.destination ? `In line for ${each.destination}` : 'In line'} ({each.spots.length})</p>
                <button class="btn btn-small btn-quiet" onclick={() => clearOneLine(each.spots)}>Clear</button>
              </div>
              <ol class="line-list">
                {#each each.spots as spot, index (spot.studentId)}
                  <li>
                    <span class="line-position">{index + 1}</span>
                    <strong>{staffStudentName(spot.studentId, spot.studentName)}</strong>
                    <span class="muted small">{each.destination ? '' : `for ${spot.destination}, `}since {time(spot.joinedAt)}</span>
                    <button class="btn btn-small start-now" aria-label="Start {staffStudentName(spot.studentId, spot.studentName)}'s pass now" onclick={() => startPassFromHome(spot.studentId, spot.destination)}>
                      <Icon name="arrow-right" size={14} />Start pass
                    </button>
                    <button class="btn btn-small btn-quiet remove" aria-label="Take {staffStudentName(spot.studentId, spot.studentName)} out of the line" onclick={() => removeFromLine(spot.studentId)}>
                      <Icon name="x" size={14} />
                    </button>
                  </li>
                {/each}
              </ol>
            </div>
          {/each}
        </section>

        <section class="card hub-card" aria-labelledby="inform-hub-title">
          <div class="right-now-head">
            <h2 id="inform-hub-title">Inform the Hub</h2>
          </div>
          {#if hubDestinations.length && classRoster.length}
            <form class="hub-form" onsubmit={informHub}>
              <div class="hub-student-filters">
                <label class="field">
                  Search students
                  <input aria-label="Search Hub students" type="search" bind:value={hubStudentSearch} placeholder="Name or year group" disabled={!!pendingConcern} />
                </label>
                <label class="field">
                  Filter by year group
                  <select aria-label="Filter Hub students by year group" bind:value={hubYearGroup} disabled={!!pendingConcern}>
                    <option value="">All year groups</option>
                    <option value="unassigned">No year group</option>
                    {#each account.studentCategories as category (category.id)}
                      <option value={category.id}>{category.name}</option>
                    {/each}
                  </select>
                </label>
              </div>
              <div class="field">
                <label for="hub-student">Student</label>
                <select id="hub-student" bind:value={hubStudentId} aria-label="Student to notify" required disabled={!!pendingConcern}>
                  <option value="" disabled>Choose a student</option>
                  {#if favouriteHubStudents.length}
                    <optgroup label="Favourites">
                      {#each favouriteHubStudents as student (student.id)}
                        <option value={student.id}>{student.firstName} {student.lastName || `${student.lastPrefix}.`}</option>
                      {/each}
                    </optgroup>
                  {/if}
                  {#if otherHubStudents.length}
                    <optgroup label="All current students">
                      {#each otherHubStudents as student (student.id)}
                        <option value={student.id}>{student.firstName} {student.lastName || `${student.lastPrefix}.`}</option>
                      {/each}
                    </optgroup>
                  {/if}
                  {#if !filteredHubStudents.length}
                    <option value="" disabled>No students match these filters</option>
                  {/if}
                </select>
                {#if selectedHubStudent && staffPreferences.loaded}
                  <button
                    class="btn btn-small btn-quiet favourite-toggle"
                    type="button"
                    aria-label="{selectedHubStudentIsFavourite ? 'Remove' : 'Add'} {selectedHubStudent.firstName} {selectedHubStudent.lastName || `${selectedHubStudent.lastPrefix}.`} {selectedHubStudentIsFavourite ? 'from' : 'to'} favourites"
                    aria-pressed={selectedHubStudentIsFavourite}
                    disabled={staffPreferences.saving || !!pendingConcern}
                    onclick={() => toggleFavouriteStudent(selectedHubStudent!.id)}
                  >
                    <Icon name="star" size={14} />
                    {selectedHubStudentIsFavourite ? 'Remove favourite' : 'Add to favourites'}
                  </button>
                {/if}
              </div>
              <label class="field">
                Destination
                <select bind:value={hubDestinationId} aria-label="Hub destination" required disabled={!!pendingConcern}>
                  <option value="" disabled>Choose a destination</option>
                  {#each hubDestinations as destination (destination.id)}
                    <option value={destination.id}>{destination.label}</option>
                  {/each}
                </select>
              </label>
              <fieldset class="hub-concern-choice">
                <legend>Concern status</legend>
                <label>
                  <input type="radio" name="hub-concern" value="no-concerns" bind:group={hubConcernChoice} disabled={!!pendingConcern} />
                  No Concerns
                </label>
                <label>
                  <input
                    type="radio"
                    name="hub-concern"
                    value="concern"
                    bind:group={hubConcernChoice}
                    disabled={!!pendingConcern || !hubRuntime.hosted || hubRuntime.status !== 'ready' || !hubMail.concernPolicyLoaded || !!hubMail.concernPolicyError}
                  />
                  Concern
                </label>
                {#if !hubRuntime.hosted}
                  <p class="muted small">Private concern notes require the Hub Host. Browser-only mode can send No Concerns notifications.</p>
                {:else if hubMail.concernPolicyError}
                  <p class="small error" role="alert">{hubMail.concernPolicyError}</p>
                {:else if !hubMail.concernPolicyLoaded}
                  <p class="muted small" role="status">Loading TIC concern-routing policy…</p>
                {:else if hubConcernChoice === 'concern'}
                  <div class="hub-concern-fields">
                    <label class="field" for="hub-concern-note">
                      Brief explanation
                      <textarea
                        id="hub-concern-note"
                        bind:value={hubConcernNote}
                        maxlength="2000"
                        rows="3"
                        required
                        placeholder="Share only relevant context for the selected staff."
                      ></textarea>
                    </label>
                    <fieldset class="hub-concern-routing">
                      <legend>Who should receive this note?</legend>
                      {#if hubMail.concernPolicy.availableScopes.includes('tic')}
                        <label><input type="radio" name="hub-concern-scope" value="tic" bind:group={hubConcernScope} /> TIC only{hubMail.concernPolicy.defaultScope === 'tic' ? ' (default)' : ''}</label>
                      {/if}
                      {#if hubMail.concernPolicy.availableScopes.includes('all-staff')}
                        <label><input type="radio" name="hub-concern-scope" value="all-staff" bind:group={hubConcernScope} /> All staff{hubMail.concernPolicy.defaultScope === 'all-staff' ? ' (default)' : ''}</label>
                      {/if}
                      {#if hubMail.concernPolicy.availableScopes.includes('selected')}
                        <label><input type="radio" name="hub-concern-scope" value="selected" bind:group={hubConcernScope} /> Choose staff{hubMail.concernPolicy.defaultScope === 'selected' ? ' (default)' : ''}</label>
                      {/if}
                      {#if hubConcernScope === 'selected'}
                        {#if hubMail.recipientsError}
                          <p class="small error" role="alert">{hubMail.recipientsError}</p>
                        {:else if !hubMail.recipientsLoaded}
                          <p class="muted small" role="status">Loading authorised staff profiles…</p>
                        {:else}
                          <div class="hub-recipient-list">
                            {#each hubMail.recipients as recipient (recipient.staffId)}
                              <label>
                                <input type="checkbox" bind:group={hubConcernRecipientIds} value={recipient.staffId} />
                                {recipient.displayName} ({recipient.role.toUpperCase()})
                              </label>
                            {/each}
                          </div>
                        {/if}
                      {/if}
                    </fieldset>
                    <p class="muted small">The note is visible to you, TIC and the selected recipients. Other staff see only a concern warning indicator.</p>
                  </div>
                {/if}
              </fieldset>
              <button
                class="btn btn-primary"
                disabled={(!pendingConcern && (!hubStudentId || !hubDestinationId)) || hubNoticeState === 'saving'}
              >
                <Icon name="arrow-right" size={14} />
                {hubNoticeState === 'saving' ? 'Saving…' : pendingConcern ? 'Retry concern delivery' : 'Send notification'}
              </button>
            </form>
            {#if staffPreferences.error}
              <p class="small hub-notice error" role="alert">{staffPreferences.error}</p>
            {:else if !staffPreferences.loaded}
              <p class="muted small" role="status">Loading personal favourites…</p>
            {:else if !hubRuntime.hosted}
              <p class="muted small">Favourites are saved in this browser.</p>
            {/if}
          {:else if !classRoster.length}
            <p class="muted small">Add current students to this class before sending a Hub notification.</p>
          {:else if !hubRuntime.hosted || hubRuntime.session?.role === 'tic'}
            <p class="muted small">
              No destinations are enabled yet.
              <a href="/destinations">Choose destinations available in Inform the Hub</a>.
            </p>
          {:else}
            <p class="muted small">No destinations are enabled for Inform the Hub. Ask the TIC to configure them.</p>
          {/if}
          {#if hubNoticeMessage}
            <p class="small hub-notice" class:saved={hubNoticeState === 'saved'} class:pending={hubNoticeState === 'pending'} class:error={hubNoticeState === 'error'} role="status">
              {hubNoticeMessage}
            </p>
          {/if}
          {#if currentHubVisits.length}
            <ul class="hub-visits">
              {#each currentHubVisits as visit (visit.id)}
                <li>
                  <span>
                    {#if visit.hasConcern}
                      <Icon name="alert-triangle" size={15} />
                      <span class="sr-only">A concern is recorded; private details are in the Mail Centre.</span>
                    {/if}
                    <strong>{staffStudentName(visit.studentId, visit.studentName)}</strong>
                    {#if visit.arrivedAtHubAt && !visit.arrivedBackAtClassAt}
                      <details class="hub-staff-note">
                        <summary>Hub staff note {visit.hubStaffNote ? 'saved' : '(optional)'}</summary>
                        <label>Note after speaking with the student
                          <textarea rows="2" maxlength="1000" value={hubStaffNoteDrafts[visit.id] ?? visit.hubStaffNote ?? ''} oninput={(event) => (hubStaffNoteDrafts[visit.id] = event.currentTarget.value)}></textarea>
                        </label>
                        <button class="btn btn-small" disabled={savingHubNoteId === visit.id} onclick={() => void saveHubStaffNote(visit.id)}>{savingHubNoteId === visit.id ? 'Saving…' : 'Save note'}</button>
                      </details>
                    {/if}
                    {#if needsPeriodTransitionReview(visit)}
                      <span class="muted small">
                        · {visit.className ?? visit.periodName ?? 'Previous class'}
                      </span>
                    {/if}
                    <span class="muted small"> · {visit.destinationLabel} · {time(visit.leftClassAt ?? visit.arrivedAtHubAt ?? '')}</span>
                  </span>
                  <span class="hub-visit-actions">
                    {#if needsPeriodTransitionReview(visit)}
                      <span class="badge">Period transition review</span>
                    {/if}
                    <span class="badge">{hubStatusText(visit)}</span>
                    {#if hubVisitStatus(visit) === 'left-hub-awaiting-class'}
                      <button
                        class="btn btn-small"
                        disabled={hubNoticeState === 'saving'}
                        onclick={() => confirmHubReturn(visit.id)}
                      >Confirm back in class</button>
                    {:else if hubVisitStatus(visit) === 'on-the-way'}
                      <button
                        class="btn btn-small"
                        disabled={hubNoticeState === 'saving'}
                        onclick={() => confirmHubArrival(visit.id)}
                      >Confirm arrived at Hub</button>
                      <button
                        class="btn btn-quiet btn-small"
                        disabled={hubNoticeState === 'saving'}
                        onclick={() => requestHubMovementCancellation(visit.id, 'withdrawn')}
                      >Cancel notification</button>
                      <button
                        class="btn btn-quiet btn-small"
                        disabled={hubNoticeState === 'saving'}
                        onclick={() => requestHubMovementCancellation(visit.id, 'did-not-arrive')}
                      >Mark did not arrive</button>
                    {:else if hubVisitStatus(visit) === 'at-hub'}
                      {#if visit.hubTimerMinutes}
                        <button class="btn btn-small" disabled={!!extendingHubTimerId} onclick={() => void addHubVisitTime(visit.id, 5)}>{extendingHubTimerId === visit.id ? 'Adding…' : 'Add 5 min'}</button>
                      {/if}
                      <button
                        class="btn btn-small"
                        disabled={hubNoticeState === 'saving'}
                        onclick={() => requestHubDeparture(visit.id)}
                      >Confirm left Hub</button>
                    {/if}
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <section class="this-class-log">
          <div class="log-head">
            <h2>This class</h2>
            <a class="btn btn-quiet btn-small" href="/history">All history<Icon name="arrow-right" size={14} /></a>
          </div>
          {#if activity.length}
            <ol class="activity">
              {#each activity as event (event.id)}
                <li class:denied={event.denied}>
                  <span class="when">{time(event.at)}</span>
                  <span>{event.text}</span>
                  {#if event.pass}<PassMarks pass={event.pass} />{/if}
                </li>
              {/each}
            </ol>
          {:else}
            <p class="muted small">Nothing yet. Passes and your answers to requests show up here as they happen.</p>
          {/if}
        </section>
      {:else}
        <QuietScene {season} message={account.activeClass?.onSchedule ? `No class right now. ${timing}.` : 'No class is on the kiosk. Choose one above.'} />
      {/if}
    </div>

    <div class="side">
    <!-- Requests and No passes live in the drawer in the bottom-right corner, on every page. -->
    <section class="devices-card" aria-labelledby="devices-title">
      <h2 id="devices-title" class="devices-title">Devices</h2>

      <div class="device" aria-labelledby="kiosk-title">
        <div class="panel-head">
          <h3 id="kiosk-title">
            <Icon name="kiosk" size={18} />Kiosk
            <a class="device-gear" href="/kiosk" aria-label="Kiosk settings" title="Kiosk settings"><Icon name="settings" size={15} /></a>
          </h3>
          <span class="kiosk-state"><span class="status-dot {kiosk.dot}" aria-hidden="true"></span>{kiosk.text.replace(/^Kiosk (\w)/, (_, first) => first.toUpperCase())}</span>
        </div>
        {#if !account.kiosk}
          <p class="muted small">Students take a pass on a tablet or Chromebook by the door, or on this computer.</p>
          {#if account.pin}
            <div class="kiosk-actions">
              <button class="btn btn-small btn-primary" onclick={() => (pairing = true)}>Pair a device</button>
              <button class="btn btn-small" onclick={thisComputer}>Use this computer</button>
            </div>
          {:else}
            <a class="btn btn-small" href="/kiosk">Set up the kiosk</a>
          {/if}
        {:else if account.kiosk.kind === 'this-computer'}
          <div class="kiosk-actions">
            <button class="btn btn-small btn-primary" onclick={openDoor} disabled={!account.activeClass}>
              <Icon name="lock" size={14} />Open kiosk screen
            </button>
            <button class="btn btn-small" onclick={() => (pairing = true)}>Pair a device instead</button>
            <button class="btn btn-small btn-quiet" onclick={disconnect}>Stop using it</button>
          </div>
        {:else if kioskOnline()}
          <div class="kiosk-actions">
            <button class="btn btn-small btn-quiet" onclick={disconnect}>Disconnect</button>
          </div>
        {:else}
          <p class="muted small">
            {account.kiosk.lastSeenAt ? `Last connected at ${time(account.kiosk.lastSeenAt)}. ` : ''}Until it reconnects,
            students can only come back in there.
          </p>
          <div class="kiosk-actions">
            <button
              class="btn btn-small btn-primary"
              onclick={() => {
                reconnecting = true;
                pairing = true;
              }}>Reconnect</button
            >
            <button class="btn btn-small btn-quiet" onclick={disconnect}>Disconnect</button>
          </div>
        {/if}
      </div>

      <div class="device" aria-labelledby="student-link-title">
        <div class="panel-head">
          <h3 id="student-link-title">
            <Icon name="smartphone" size={18} />Student devices
            <a class="device-gear" href="/student-link" aria-label="Student devices settings" title="Student devices settings"><Icon name="settings" size={15} /></a>
          </h3>
          {#if account.studentLink?.open}
            <span class="kiosk-state">
              <span class="status-dot" class:live={studentLink.viewers > 0} aria-hidden="true"></span>{devicesText()}
            </span>
          {/if}
        </div>
        {#if account.studentLink?.open && currentRoom()}
          <RoomCode code={currentRoom()!.code} size="small" />
          <div class="kiosk-actions">
            <!-- Just an icon, so the three buttons fit on one line. -->
            <button
              class="btn btn-small icon-only"
              onclick={copyJoinLink}
              aria-label={copied ? 'Copied' : 'Copy link'}
              title={copied ? 'Copied' : 'Copy the join link'}><Icon name={copied ? 'check' : 'copy'} size={14} /></button
            >
            <button class="btn btn-small" onclick={() => board?.requestFullscreen?.()}><Icon name="maximize" size={14} />Full screen</button>
            <button class="btn btn-small" onclick={popOutRoom}><Icon name="pop-out" size={14} />Pop out</button>
          </div>
        {:else if account.studentLink?.open}
          <p class="muted small">A code for students to join appears when a class is on.</p>
        {:else}
          <p class="muted small">Students can join each class from their own Chromebook or phone with a code.</p>
          <div class="kiosk-actions"><a class="btn btn-small" href="/student-link">Turn on student devices</a></div>
        {/if}
      </div>
    </section>
    </div>
  </div>
{/if}

<div class="board-holder" bind:this={board}><RoomBoard /></div>

{#if startingPass}<StartPassDialog onClose={() => (startingPass = false)} />{/if}

{#if pairing}
  <PairingDialog
    {reconnecting}
    onClose={() => {
      pairing = false;
      reconnecting = false;
    }}
    onUseThisComputer={thisComputer}
  />
{/if}

{#if confirming}
  {@const change = confirming}
  <ConfirmDialog
    title={change.title}
    message={change.message}
    confirmLabel={change.label}
    onConfirm={() => {
      change.run();
      confirming = null;
    }}
    onCancel={() => (confirming = null)}
  />
{/if}

<style>
  .hub-staff-note { display:grid; gap:6px; margin-top:6px; }
  .hub-staff-note summary { cursor:pointer; font-size:12px; font-weight:700; }
  .hub-staff-note label { display:grid; gap:4px; font-size:12px; }
  .hub-staff-note textarea { box-sizing:border-box; width:min(360px,100%); padding:8px; border:1px solid var(--border-strong); border-radius:6px; font:inherit; }
  .icon-only {
    padding-inline: 8px;
  }

  .line-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .right-now-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .hub-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    align-items: end;
    gap: 12px;
  }

  .hub-concern-choice,
  .hub-concern-routing {
    min-width: 0;
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
  }

  .hub-concern-choice {
    display: grid;
    grid-column: 1 / -1;
    gap: 8px;
  }

  .hub-concern-choice > label,
  .hub-concern-routing > label {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .hub-concern-choice input,
  .hub-concern-routing input {
    margin: 0;
  }

  .hub-concern-fields {
    display: grid;
    gap: 10px;
    padding-top: 4px;
  }

  .hub-concern-fields textarea {
    width: 100%;
    resize: vertical;
  }

  .hub-concern-routing {
    display: grid;
    gap: 8px;
  }

  .hub-recipient-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px;
    max-height: 180px;
    overflow: auto;
    padding: 4px;
  }

  .hub-recipient-list label {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .hub-visits li > span:first-child {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .hub-student-filters {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  .favourite-toggle {
    margin-top: 8px;
  }

  .hub-visits {
    display: grid;
    gap: 8px;
    margin: 16px 0 0;
    padding: 0;
    list-style: none;
  }

  .hub-visits li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }

  .hub-visit-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .hub-notice {
    margin: 12px 0 0;
  }

  .hub-notice.saved {
    color: var(--live);
  }

  .hub-notice.pending,
  .hub-notice.error {
    color: var(--warn);
  }

  @media (max-width: 720px) {
    .hub-form {
      grid-template-columns: 1fr;
    }

    .hub-student-filters {
      grid-template-columns: 1fr;
    }
  }

  .who {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }

  .nowrap {
    white-space: nowrap;
  }

  .minutes {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-variant-numeric: tabular-nums;
  }

  .minutes.late {
    color: var(--warn);
    font-weight: 700;
  }

  .pie {
    width: 18px;
    height: 18px;
    flex: none;
  }

  .pie circle {
    fill: var(--surface-sunk);
    stroke: var(--border);
    stroke-width: 1;
  }

  .pie .slice {
    fill: var(--accent);
    stroke: none;
  }

  .late .pie .slice {
    fill: var(--warn);
  }

  .line-list .start-now {
    margin-left: auto;
  }

  /* Only shown while it's full screen. */
  .board-holder:not(:fullscreen) {
    display: none;
  }

  /*
   * Home fits the window: the side column fills it top to bottom, and the
   * footer sits at the foot of the middle column, so nothing scrolls until the
   * middle column outgrows the window.
   */
  .home {
    --fit: calc(100vh - 40px - 24px);
    flex: 1;
    display: grid;
    margin-bottom: 24px;
    grid-template-columns: minmax(0, 1fr) 380px;
    align-items: start;
    gap: 24px;
    max-width: 1320px;
  }

  .home-main {
    display: flex;
    flex-direction: column;
    gap: 22px;
    min-height: var(--fit);
  }

  .home-head {
    display: grid;
    gap: 8px;
  }

  .title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 14px;
  }

  .title-row h1 {
    font-size: 30px;
  }

  .status-badge {
    padding: 3px 12px;
    font-size: 13.5px;
  }


  .schedule-menu {
    margin-left: auto;
    color: var(--muted);
    font-size: 15px;
  }

  .context-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    margin-left: -8px;
    font-size: 17px;
  }

  .timing {
    color: var(--muted);
    font-weight: 600;
  }

  .this-class {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .this-class-log {
    display: grid;
    gap: 6px;
  }

  .log-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .activity {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .activity li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    padding: 9px 0;
    border-top: 1px solid var(--border);
    font-size: 14.5px;
  }

  .activity li:first-child {
    border-top: 0;
  }

  .activity .when {
    width: 72px;
    color: var(--muted);
    font-size: 13px;
    font-weight: 700;
  }

  .activity li.denied {
    color: var(--danger);
  }

  /* The live column: what the teacher can do right now, then what students are asking. */
  .side {
    position: sticky;
    top: 40px;
    display: grid;
    align-content: start;
    gap: 12px;
    height: var(--fit);
  }

  .devices-card {
    display: grid;
    align-content: start;
    gap: 14px;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .devices-title {
    color: var(--faint);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .device {
    display: grid;
    gap: 10px;
  }

  .device + .device {
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }

  .panel-head h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    white-space: nowrap;
  }

  .kiosk-state {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
    color: var(--muted);
    font-size: 13px;
    font-weight: 700;
  }

  /* Opens the device's own page. */
  .device-gear {
    display: inline-grid;
    place-items: center;
    width: 26px;
    height: 26px;
    margin-left: -2px;
    border-radius: 6px;
    color: var(--faint);
  }

  .device-gear:hover,
  .device-gear:focus-visible {
    background: var(--surface-sunk);
    color: var(--text);
  }

  .kiosk-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .panel-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 4px 12px;
  }

  @media (max-width: 1100px) {
    .home {
      grid-template-columns: 1fr;
    }

    .side {
      position: static;
      height: auto;
      grid-row: 2;
    }
  }
</style>
