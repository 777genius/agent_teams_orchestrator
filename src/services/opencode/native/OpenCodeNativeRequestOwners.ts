/** Local object capabilities stay outside public handles, contexts and JSON. */
export class OpenCodeNativeRequestOwners<T> {
  private readonly owners = new WeakMap<object, T>()
  constructor(
    private readonly assertAdmitted: (custody: T) => void,
    private readonly samePhysicalEpoch: (first: T, second: T) => boolean,
  ) {}

  bind<O extends object>(owner: O, custody: T): O {
    this.assertAdmitted(custody)
    const previous = this.owners.get(owner)
    if (previous && !this.samePhysicalEpoch(previous, custody)) throw new Error('native_custody_unavailable')
    this.owners.set(owner, custody)
    return owner
  }
  inherit<O extends object>(owner: O, source: object): O {
    const custody = this.owners.get(source)
    return custody ? this.bind(owner, custody) : owner
  }
  has(owner: object): boolean { return this.owners.has(owner) }
  capture(owner: object | undefined): T {
    const custody = owner && this.owners.get(owner)
    if (!custody) throw new Error('native_custody_unavailable')
    this.assertAdmitted(custody)
    return custody
  }
}
