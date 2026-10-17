/** The longest delay a timer takes: longer ones (a far-future expiry minus now) overflow, and the timer fires after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
