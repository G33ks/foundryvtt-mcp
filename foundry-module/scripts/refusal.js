/**
 * An expected refusal: a command turned the call down by design (an id that
 * names nothing, an unknown status, input only a person could give), as
 * opposed to a failure.
 *
 * The transport sends its message as `error`, like any failure, and adds
 * `code` and `refusal: true`. A server before 3.1.0 reads only `error`; a
 * later one reports the refusal without treating it as a failure.
 */
export class CommandRefusal extends Error {
  /**
   * @param {string} code  a short kebab-case reason, such as `not-found`
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'CommandRefusal';
    this.code = code;
  }
}
