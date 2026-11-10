// the choice of the newsletter of a login by Google, GitHub or LinkedIn: the page of the shop adds
// newsletter=true to the start of the login, the signed state carries it to the callback (it is
// never a cookie of its own, which nobody signs)

// whether the verified state of the login carries the choice. Only the boolean the start writes
// counts, whatever else a payload could hold; the state is checked (signature, time window, the
// guest who finishes the login) before this is asked
export const newsletterOfState = (state: { newsletter?: unknown }): boolean =>
  state.newsletter === true;
