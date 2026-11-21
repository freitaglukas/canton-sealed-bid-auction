// FROZEN (Wave 0): package-name template ids.
export const PKG = '#sealed-auction'
export const MODULE = 'SealedAuction.Auction'
const id = (name: string) => `${PKG}:${MODULE}:${name}`

export const T = {
  AuctioneerRole: id('AuctioneerRole'),
  Auction: id('Auction'),
  AuctionInvitation: id('AuctionInvitation'),
  Bid: id('Bid'),
  AuctionOutcome: id('AuctionOutcome'),
  NoBidNotice: id('NoBidNotice'),
  AuctionResult: id('AuctionResult'),
} as const

export type TemplateName = keyof typeof T

/** Daml error ids raised by the sealed-auction package. */
export const SA_ERRORS = ['SA_INCOMPLETE_CLOSE', 'SA_UNKNOWN_INVITATION', 'SA_DUPLICATE_ENTRY', 'SA_NON_POSITIVE_BID'] as const
export type SaErrorId = (typeof SA_ERRORS)[number]

/** true if a (package-id or package-name form) template id refers to our template `name`. */
export function isTemplate(templateId: string, name: TemplateName): boolean {
  return templateId.endsWith(`:${MODULE}:${name}`)
}
