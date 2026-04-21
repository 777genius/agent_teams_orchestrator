import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InfoLabel } from "@/components/shared/info-label";

interface SessionsValues {
  scope?: string;
  dm_scope?: string;
}

interface Props {
  value: SessionsValues;
  onChange: (v: SessionsValues) => void;
}

/** Session scoping settings (scope + DM scope). */
export function BehaviorSessionsCard({ value, onChange }: Props) {
  const { t } = useTranslation("config");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("behavior.sessionsTitle")}</CardTitle>
        <CardDescription>{t("behavior.sessionsDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <InfoLabel tip={t("sessions.scopeTip")}>{t("sessions.scope")}</InfoLabel>
            <Select
              value={value.scope ?? "per-sender"}
              onValueChange={(v) => onChange({ ...value, scope: v })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="per-sender">Per Sender</SelectItem>
                <SelectItem value="global">Global</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <InfoLabel tip={t("sessions.dmScopeTip")}>{t("sessions.dmScope")}</InfoLabel>
            <Select
              value={value.dm_scope ?? "per-channel-peer"}
              onValueChange={(v) => onChange({ ...value, dm_scope: v })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="main">Main</SelectItem>
                <SelectItem value="per-peer">Per Peer</SelectItem>
                <SelectItem value="per-channel-peer">Per Channel Peer</SelectItem>
                <SelectItem value="per-account-channel-peer">Per Account Channel Peer</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
