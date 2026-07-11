// Signals from a launched Claude run back to the wrapping launcher/queue.
// 75 is chosen deliberately: it is not reserved by Node, claude or cmd.exe and
// sits outside the usual 0/1 range, so it cannot collide with a real success or
// generic-failure exit.
export const SESSION_LIMIT_EXIT_CODE = 75;
