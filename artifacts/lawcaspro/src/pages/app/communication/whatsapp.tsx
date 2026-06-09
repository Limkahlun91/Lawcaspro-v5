import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function WhatsAppInboxPlaceholderPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>WhatsApp Inbox</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-sm text-slate-600">WhatsApp integration reserved for next phase.</div>
      </CardContent>
    </Card>
  );
}

