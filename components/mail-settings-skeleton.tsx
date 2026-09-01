import { Skeleton } from "./ui/primitives";

/** Placeholder for the Mail settings tab. Shared by the dynamic chunk load and
 * the account fetch so the tab paints one skeleton, not two. Mirrors the
 * loaded anatomy — group header with its action, then the r16 ring holding
 * two 52px account-row bones — so the swap to real content doesn't reflow. */
export function MailSettingsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading mail settings" className="space-y-7">
      <section>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-52" />
          </div>
          <Skeleton className="h-8 w-28 rounded-(--r-control)" />
        </div>
        <div className="brain-settings-group mt-2.5">
          {[0, 1].map((row) => (
            <div key={row} className="brain-settings-row" data-lead="">
              <Skeleton className="size-7 rounded-block" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-3 w-56 max-w-full" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
