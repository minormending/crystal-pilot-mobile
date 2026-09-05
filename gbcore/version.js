// Which build this is.
//
// Baked into a module rather than fetched, and that distinction is the whole
// point: this is the identity of the code *now running*, which is the only
// thing that can be compared against what the server has. Read the version off
// the network and you learn what is deployed, which is exactly the question
// nobody was asking when they wondered why a bug they had seen fixed was still
// there.
//
// It has to match the service worker's cache name, because that is what a
// deploy bumps. Two places to change is one too many, so tools/check-app
// asserts they agree rather than trusting anyone to remember.
export const VERSION = 'v135';
