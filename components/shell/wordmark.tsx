/** The Brain lockup, at two sizes. `"sm"` is the 18px mark and the word in H3,
 *  which the sidebar head wraps in the Home button. `"lg"` is the 36px mark and
 *  the word in Title, which the two password screens stand above the field:
 *  there the lockup is not a control in a row, it is the whole subject of the
 *  screen, and the display register is what says so. One drawing either way, so
 *  the mark and the word can never drift apart at one of the sizes.
 *
 *  A fragment on purpose: the shell's DOM contract fixtures snapshot the
 *  button's children, and a wrapper would change them. */
export function Wordmark({ size = "sm" }: { size?: "sm" | "lg" }) {
  const large = size === "lg";
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo-small.png"
        alt=""
        className={
          large
            ? "size-9 rounded-block object-cover"
            : "size-[18px] rounded-[4px] object-cover"
        }
      />
      <span className={large ? "text-title" : "text-h3"}>Brain</span>
    </>
  );
}
