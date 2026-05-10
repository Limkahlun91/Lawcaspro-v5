import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { getSupportSessionId, setSupportSessionId } from "@/lib/support-session";

export function SupportSessionRequired({
  title,
  description,
}: {
  title?: string;
  description?: string;
}) {
  const stored = getSupportSessionId();
  const [value, setValue] = useState(stored ?? "");

  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title ?? "Support session required"}</EmptyTitle>
        <EmptyDescription>
          {description ?? "This action requires an approved support session. Open a firm and request/activate one, or paste an existing session ID."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href="/platform/firms"><a><Button>Open firms</Button></a></Link>
            <Button
              variant="outline"
              onClick={() => {
                const s = value.trim();
                if (!s) {
                  setSupportSessionId(null);
                  return;
                }
                setSupportSessionId(s);
              }}
            >
              Set session ID
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setSupportSessionId(null);
                setValue("");
              }}
            >
              Clear
            </Button>
          </div>
          <div className="max-w-sm">
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Support session ID (e.g. 123)" />
          </div>
          <div className="text-xs text-slate-500">Current: {stored ? `#${stored}` : "—"}</div>
        </div>
      </EmptyContent>
    </Empty>
  );
}

