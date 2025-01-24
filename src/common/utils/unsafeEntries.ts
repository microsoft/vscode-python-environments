/** Converts an object from a trusted source (i.e. without unknown entries) to a typed array */
export default function entries<T extends { [key: string]: object }, K extends keyof T>(o: T): [keyof T, T[K]][] {
    return Object.entries(o) as [keyof T, T[K]][]
}
 