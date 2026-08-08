"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import Placeholder from "@tiptap/extension-placeholder";
import FontFamily from "@tiptap/extension-font-family";
import { Extension } from "@tiptap/core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { plainTextToHtml, sanitizeEmailHtml } from "@/lib/email-html";
import { cn } from "@/lib/utils";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Eraser,
  Highlighter,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquareQuote,
  Paperclip,
  Send,
  SmilePlus,
  Strikethrough,
  Table2,
  Underline as UnderlineIcon,
} from "lucide-react";

type ComposeMode = "reply" | "replyAll" | "forward";

type ComposeAccount = {
  id: number;
  provider: string;
  emailAddress: string;
  displayName: string | null;
  canSend: boolean;
  sendDisabledReason: string | null;
  requiresReconnectForSend?: boolean;
  signatureHtml?: string | null;
};

type ComposeMessage = {
  id: number;
  emailAccountId: number | null;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: string | null;
  sentAt: string | null;
  createdAt: string;
};

type ComposeAttachment = {
  id: number;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  storagePath: string | null;
  createdAt: string;
};

type SendResponse = {
  success: boolean;
  providerMessageId: string | null;
  sentAt: string;
};

type Props = {
  open: boolean;
  mode: ComposeMode;
  account: ComposeAccount | null;
  message: ComposeMessage | null;
  attachments: ComposeAttachment[];
  onOpenChange: (open: boolean) => void;
  onSent: (result: SendResponse) => void;
};

const FontSize = Extension.create({
  name: "fontSize",
  addOptions() {
    return {
      types: ["textStyle"],
    };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element: HTMLElement) => element.style.fontSize || null,
            renderHTML: (attributes: Record<string, unknown>) => {
              const fontSize = String(attributes.fontSize ?? "").trim();
              if (!fontSize) return {};
              return { style: `font-size: ${fontSize}` };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontSize: (fontSize: string) => ({ chain }) => chain().setMark("textStyle", { fontSize }).run(),
      unsetFontSize: () => ({ chain }) => chain().setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run(),
    };
  },
});

const BlockIndent = Extension.create({
  name: "blockIndent",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element: HTMLElement) => Number(element.getAttribute("data-indent") || 0),
            renderHTML: (attributes: Record<string, unknown>) => {
              const indent = Number(attributes.indent ?? 0);
              if (!indent) return {};
              return {
                "data-indent": String(indent),
                style: `margin-left: ${indent * 2}rem`,
              };
            },
          },
        },
      },
    ];
  },
  // @ts-expect-error tiptap RawCommands is too strict for custom extension commands
  addCommands() {
    const getTargetType = (editor: Editor) => (editor.isActive("heading") ? "heading" : "paragraph");
    return {
      indentBlock: () => ({ editor, commands }: any) => {
        const type = getTargetType(editor);
        const currentIndent = Number(editor.getAttributes(type).indent ?? 0);
        return commands.updateAttributes(type, { indent: Math.min(4, currentIndent + 1) });
      },
      outdentBlock: () => ({ editor, commands }: any) => {
        const type = getTargetType(editor);
        const currentIndent = Number(editor.getAttributes(type).indent ?? 0);
        return commands.updateAttributes(type, { indent: Math.max(0, currentIndent - 1) });
      },
    };
  },
});

function splitRecipients(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatAddress(name: string | null | undefined, email: string | null | undefined) {
  const safeEmail = String(email ?? "").trim();
  const safeName = String(name ?? "").trim();
  if (safeName && safeEmail) return `${safeName} <${safeEmail}>`;
  return safeEmail || safeName || "-";
}

function formatComposeSubject(subject: string | null, mode: ComposeMode) {
  const base = String(subject ?? "").trim() || "(no subject)";
  const prefix = mode === "forward" ? "Fwd:" : "Re:";
  return base.toLowerCase().startsWith(prefix.toLowerCase()) ? base : `${prefix} ${base}`;
}

function uniqueRecipients(values: string[], selfAddress: string) {
  const seen = new Set<string>();
  const normalizedSelf = selfAddress.trim().toLowerCase();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === normalizedSelf || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value.trim());
  }
  return out;
}

function buildQuotedHtml(message: ComposeMessage, mode: ComposeMode) {
  const timestamp = message.receivedAt || message.sentAt || message.createdAt;
  const metaTitle = mode === "forward" ? "Forwarded message" : "Original message";
  const quotedBody = message.bodyHtml
    ? sanitizeEmailHtml(message.bodyHtml)
    : plainTextToHtml(message.bodyText ?? "");

  return [
    "<p></p>",
    `<div class="email-quoted-block">`,
    `<p><strong>${metaTitle}</strong></p>`,
    `<p><strong>From:</strong> ${formatAddress(message.fromName, message.fromAddress)}</p>`,
    `<p><strong>Sent:</strong> ${timestamp ? new Date(timestamp).toLocaleString() : "-"}</p>`,
    `<p><strong>To:</strong> ${message.toAddresses.join(", ") || "-"}</p>`,
    message.ccAddresses.length ? `<p><strong>Cc:</strong> ${message.ccAddresses.join(", ")}</p>` : "",
    `<p><strong>Subject:</strong> ${message.subject || "(no subject)"}</p>`,
    "<blockquote>",
    quotedBody || "<p></p>",
    "</blockquote>",
    "</div>",
  ].filter(Boolean).join("");
}

function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("h-8 px-2", active && "bg-slate-100")}
          onClick={onClick}
          disabled={disabled}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

function EditorToolbar({ editor, onInsertSignature }: { editor: Editor | null; onInsertSignature: () => void }) {
  const [textColor, setTextColor] = useState("#1f2937");
  const [highlightColor, setHighlightColor] = useState("#fef08a");
  const emojiOptions = ["😀", "😊", "👍", "🙏", "📌", "✅", "⚖️", "📧"];
  const fontSizes = ["12px", "14px", "16px", "18px", "24px"];
  const fontFamilies = ["Arial", "Calibri", "Georgia", "Times New Roman", "Verdana"];

  if (!editor) return null;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-slate-50 p-2">
        <select
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={editor.getAttributes("textStyle").fontFamily || ""}
          onChange={(event) => {
            const value = event.target.value;
            if (!value) {
              editor.chain().focus().unsetFontFamily().run();
              return;
            }
            editor.chain().focus().setFontFamily(value).run();
          }}
        >
          <option value="">Font</option>
          {fontFamilies.map((family) => (
            <option key={family} value={family}>{family}</option>
          ))}
        </select>
        <select
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={editor.getAttributes("textStyle").fontSize || "14px"}
          onChange={(event) => editor.chain().focus().setFontSize(event.target.value).run()}
        >
          {fontSizes.map((size) => (
            <option key={size} value={size}>{size.replace("px", "")}</option>
          ))}
        </select>
        <ToolbarButton title="Bold" onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")}>
          <Bold className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")}>
          <Italic className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive("underline")}>
          <UnderlineIcon className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive("strike")}>
          <Strikethrough className="h-4 w-4" />
        </ToolbarButton>
        <label className="flex h-8 items-center gap-1 rounded-md border bg-background px-2 text-xs">
          <span>Text</span>
          <input
            type="color"
            value={textColor}
            onChange={(event) => {
              setTextColor(event.target.value);
              editor.chain().focus().setColor(event.target.value).run();
            }}
          />
        </label>
        <label className="flex h-8 items-center gap-1 rounded-md border bg-background px-2 text-xs">
          <Highlighter className="h-4 w-4" />
          <input
            type="color"
            value={highlightColor}
            onChange={(event) => {
              setHighlightColor(event.target.value);
              editor.chain().focus().toggleHighlight({ color: event.target.value }).run();
            }}
          />
        </label>
        <ToolbarButton title="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")}>
          <List className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")}>
          <ListOrdered className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Quote" onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive("blockquote")}>
          <MessageSquareQuote className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Align left" onClick={() => editor.chain().focus().setTextAlign("left").run()} active={editor.isActive({ textAlign: "left" })}>
          <AlignLeft className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Align center" onClick={() => editor.chain().focus().setTextAlign("center").run()} active={editor.isActive({ textAlign: "center" })}>
          <AlignCenter className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Align right" onClick={() => editor.chain().focus().setTextAlign("right").run()} active={editor.isActive({ textAlign: "right" })}>
          <AlignRight className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Justify" onClick={() => editor.chain().focus().setTextAlign("justify").run()} active={editor.isActive({ textAlign: "justify" })}>
          <AlignJustify className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Indent"
          onClick={() => {
            if (editor.isActive("listItem")) {
              editor.chain().focus().sinkListItem("listItem").run();
              return;
            }
            (editor.chain().focus() as any).indentBlock().run();
          }}
        >
          <IndentIncrease className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Outdent"
          onClick={() => {
            if (editor.isActive("listItem")) {
              editor.chain().focus().liftListItem("listItem").run();
              return;
            }
            (editor.chain().focus() as any).outdentBlock().run();
          }}
        >
          <IndentDecrease className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Insert link"
          onClick={() => {
            const existing = editor.getAttributes("link").href || "";
            const href = window.prompt("Enter link URL", existing);
            if (href === null) return;
            const trimmed = href.trim();
            if (!trimmed) {
              editor.chain().focus().unsetLink().run();
              return;
            }
            editor.chain().focus().extendMarkRange("link").setLink({ href: trimmed, target: "_blank", rel: "noopener noreferrer" }).run();
          }}
        >
          <Link2 className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          title="Insert image"
          onClick={() => {
            const src = window.prompt("Enter image URL");
            if (!src?.trim()) return;
            editor.chain().focus().setImage({ src: src.trim(), alt: "Email image" }).run();
          }}
        >
          <ImagePlus className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Insert table" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
          <Table2 className="h-4 w-4" />
        </ToolbarButton>
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="h-8 px-2">
              <SmilePlus className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2">
            <div className="flex flex-wrap gap-2">
              {emojiOptions.map((emoji) => (
                <Button key={emoji} type="button" variant="ghost" size="sm" onClick={() => editor.chain().focus().insertContent(emoji).run()}>
                  {emoji}
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <ToolbarButton title="Insert signature" onClick={onInsertSignature}>
          Sig
        </ToolbarButton>
        <ToolbarButton title="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
          <Eraser className="h-4 w-4" />
        </ToolbarButton>
      </div>
    </TooltipProvider>
  );
}

export function EmailComposeDialog({ open, mode, account, message, attachments, onOpenChange, onSent }: Props) {
  const { toast } = useToast();
  const [toValue, setToValue] = useState("");
  const [ccValue, setCcValue] = useState("");
  const [bccValue, setBccValue] = useState("");
  const [subject, setSubject] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState(false);

  const initialHtml = useMemo(() => {
    if (!message || !account) return "<p></p>";
    return buildQuotedHtml(message, mode);
  }, [account, message, mode]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: true, autolink: true }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Image,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: "Write your email..." }),
      FontFamily,
      FontSize,
      BlockIndent,
    ],
    content: initialHtml,
    immediatelyRender: false,
  });

  useEffect(() => {
    if (!open || !message || !account) return;
    const selfAddress = account.emailAddress;
    const replyRecipients = uniqueRecipients([message.fromAddress ?? ""], selfAddress);
    const replyAllTo = uniqueRecipients([message.fromAddress ?? "", ...message.toAddresses], selfAddress);
    const replyAllCc = uniqueRecipients(message.ccAddresses, selfAddress);
    setToValue(mode === "reply" ? replyRecipients.join(", ") : mode === "replyAll" ? replyAllTo.join(", ") : "");
    setCcValue(mode === "replyAll" ? replyAllCc.join(", ") : "");
    setBccValue("");
    setSubject(formatComposeSubject(message.subject, mode));
    editor?.commands.setContent(initialHtml, { emitUpdate: false } as any);
  }, [account, editor, initialHtml, message, mode, open]);

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!message) throw new Error("Message not found");
      const path = mode === "reply" ? "reply" : mode === "replyAll" ? "reply-all" : "forward";
      const bodyHtml = editor?.getHTML() ?? "<p></p>";
      const bodyText = editor?.getText({ blockSeparator: "\n\n" }) ?? "";
      return apiFetchJson(`/communication/messages/${message.id}/${path}`, {
        method: "POST",
        body: {
          to: splitRecipients(toValue),
          cc: splitRecipients(ccValue),
          bcc: splitRecipients(bccValue),
          subject,
          bodyHtml,
          bodyText,
          attachments: [],
        } as unknown as BodyInit,
      }) as Promise<SendResponse>;
    },
    onSuccess: (result) => {
      toast({ title: "Email sent", description: "The email has been sent successfully." });
      onSent(result);
      onOpenChange(false);
    },
    onError: (error) => toastError(toast, error),
  });

  const recipients = splitRecipients(toValue);
  const editorText = editor?.getText({ blockSeparator: "\n\n" }).trim() ?? "";
  const bodyLooksEmpty = !editorText;
  const sendDisabledReason = account?.sendDisabledReason ?? (!account ? "Connected mailbox not found." : null);

  const handleInsertSignature = () => {
    if (!editor || !account?.signatureHtml) return;
    editor.chain().focus().insertContent(account.signatureHtml).run();
  };

  const handleSendClick = () => {
    if (!recipients.length) {
      toast({ title: "Recipient required", description: "To cannot be empty.", variant: "destructive" });
      return;
    }
    if (!subject.trim()) {
      setPendingConfirm(true);
      return;
    }
    sendMutation.mutate();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[92vh] max-w-6xl flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {mode === "reply" ? "Reply" : mode === "replyAll" ? "Reply All" : "Forward"}
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">
            {!account?.canSend && sendDisabledReason ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {sendDisabledReason}
              </div>
            ) : null}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>From</Label>
                <Input value={account ? formatAddress(account.displayName, account.emailAddress) : ""} readOnly />
              </div>
              <div className="space-y-1.5">
                <Label>Subject</Label>
                <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label>To</Label>
                <Input value={toValue} onChange={(event) => setToValue(event.target.value)} placeholder="recipient@example.com" />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label>Cc</Label>
                <Input value={ccValue} onChange={(event) => setCcValue(event.target.value)} placeholder="Optional" />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label>Bcc</Label>
                <Input value={bccValue} onChange={(event) => setBccValue(event.target.value)} placeholder="Optional" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Body</Label>
              <EditorToolbar editor={editor} onInsertSignature={handleInsertSignature} />
              <div className="rounded-lg border bg-white">
                <EditorContent
                  editor={editor}
                  className="min-h-[360px] px-4 py-3 [&_.ProseMirror]:min-h-[320px] [&_.ProseMirror]:outline-none [&_.ProseMirror_blockquote]:border-l-4 [&_.ProseMirror_blockquote]:border-slate-300 [&_.ProseMirror_blockquote]:pl-4 [&_.ProseMirror_table]:w-full [&_.ProseMirror_table]:border-collapse [&_.ProseMirror_td]:border [&_.ProseMirror_td]:p-2 [&_.ProseMirror_th]:border [&_.ProseMirror_th]:bg-slate-50 [&_.ProseMirror_th]:p-2"
                />
              </div>
              {bodyLooksEmpty ? (
                <div className="text-xs text-amber-700">Body is empty. You can still send after review.</div>
              ) : null}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Attachments</Label>
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button type="button" variant="outline" size="sm" disabled>
                          <Paperclip className="mr-2 h-4 w-4" />
                          Attach file
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Attachment sending will be enabled in next phase.</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className="rounded-lg border p-3">
                {mode === "forward" && attachments.length ? (
                  <div className="space-y-2">
                    <div className="text-sm text-slate-700">Original attachments are not forwarded automatically in this version.</div>
                    <div className="flex flex-wrap gap-2">
                      {attachments.map((attachment) => (
                        <Badge key={attachment.id} variant="outline">
                          {attachment.filename}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-slate-500">No outgoing attachments in this phase.</div>
                )}
              </div>
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={handleSendClick} disabled={sendMutation.isPending || !account?.canSend}>
              <Send className="mr-2 h-4 w-4" />
              {sendMutation.isPending ? "Sending..." : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingConfirm} onOpenChange={setPendingConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send without subject?</AlertDialogTitle>
            <AlertDialogDescription>
              This email has no subject. Confirm if you still want to send it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setPendingConfirm(false);
                sendMutation.mutate();
              }}
            >
              Send Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
