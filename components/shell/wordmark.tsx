/** The Brain lockup: the 18px mark and the word in H3. The sidebar head wraps
 *  it in the Home button, the login page stands it at the top of the paper —
 *  one drawing, so the two never drift. A fragment on purpose: the shell's
 *  DOM contract fixtures snapshot the button's children, and a wrapper would
 *  change them. */
export function Wordmark() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo-small.png"
        alt=""
        className="size-[18px] rounded-[4px] object-cover"
      />
      <span className="text-h3">Brain</span>
    </>
  );
}
