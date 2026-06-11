// Shared command-detail content: the autocomplete tooltip and the slash-pill
// info popover render the same description + source tag.
export function CommandInfo({ cmd }) {
  return (
    <>
      {cmd.description}
      {cmd.source && <span className="cmd-source"> ({cmd.source})</span>}
    </>
  );
}
