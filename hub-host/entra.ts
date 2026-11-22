import { ConfidentialClientApplication } from "@azure/msal-node";

export type EntraOptions = {
  tenantId: string;
  clientId: string;
  redirectUri: string;
  certificateThumbprintSha256: string;
  privateKey: string | Buffer;
  mfaPolicyConfirmed: boolean;
};

export function createEntraClient(options: EntraOptions) {
  if (!options.mfaPolicyConfirmed) {
    throw new Error(
      "Entra sign-in requires ICT confirmation that the tenant policy enforces MFA.",
    );
  }
  if (!isGuid(options.tenantId) || !isGuid(options.clientId)) {
    throw new Error("Entra tenant and client IDs must be GUIDs.");
  }
  if (!/^https:\/\//i.test(options.redirectUri)) {
    throw new Error("Entra sign-in requires an HTTPS redirect URI.");
  }
  const thumbprint = options.certificateThumbprintSha256
    .replaceAll(":", "")
    .trim();
  if (!/^[a-f\d]{64}$/i.test(thumbprint)) {
    throw new Error("The Entra certificate SHA-256 thumbprint is invalid.");
  }
  const privateKey = Buffer.isBuffer(options.privateKey)
    ? options.privateKey.toString("utf8")
    : options.privateKey;
  if (
    !privateKey.includes("-----BEGIN") ||
    !privateKey.includes("PRIVATE KEY-----")
  ) {
    throw new Error("The Entra private key file is not a PEM private key.");
  }

  return new ConfidentialClientApplication({
    auth: {
      clientId: options.clientId,
      authority: `https://login.microsoftonline.com/${options.tenantId}`,
      clientCertificate: {
        thumbprintSha256: thumbprint,
        privateKey,
      },
    },
  });
}

export function isGuid(value: string) {
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
    value,
  );
}

export function claimString(claims: Record<string, unknown>, name: string) {
  return typeof claims[name] === "string" ? (claims[name] as string) : null;
}
