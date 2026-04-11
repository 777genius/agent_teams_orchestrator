export type AgentTeamsTier =
  | 'guest'
  | 'free'
  | 'starter'
  | 'pro'
  | 'business';

export type AgentTeamsCapabilityGrant = {
  granted: boolean;
  required_tier: string;
  killswitched: boolean;
};

export type AgentTeamsCapabilityClaims = {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
  jti: string;
  tier: string;
  features: Record<string, AgentTeamsCapabilityGrant>;
  providers: Record<string, AgentTeamsCapabilityGrant>;
  models: Record<string, AgentTeamsCapabilityGrant>;
  killswitches: Record<string, boolean>;
};

export type AgentTeamsSessionSubject = {
  id: string;
  tier: string;
};

export type AgentTeamsSessionRecord = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  subject: AgentTeamsSessionSubject;
};

export type AgentTeamsCapabilitiesRecord = {
  token: string;
  tokenType: 'JWT';
  expiresAt: number;
  fetchedAt: number;
  integrity: 'verified' | 'transport';
  claims: AgentTeamsCapabilityClaims;
};

export type AgentTeamsState = {
  clientId?: string;
  session?: AgentTeamsSessionRecord;
  capabilities?: AgentTeamsCapabilitiesRecord;
};

export type AgentTeamsSessionResponse = {
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
  subject: AgentTeamsSessionSubject;
};

export type AgentTeamsCapabilitiesResponse = {
  token: string;
  token_type: 'JWT';
  expires_at: string;
  claims_preview: AgentTeamsCapabilityClaims;
};
