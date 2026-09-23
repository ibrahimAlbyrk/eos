// The new-task / new-session hero shown in the empty transcript area (Messages'
// .messages-empty): a thin 46px terminal glyph over the headline "What should we
// build in <u>project</u>?". The underlined project is dynamic and disappears
// entirely when no folder is set, leaving just "What should we build?". No
// suggestion chips — the composer below is the only input. Reference: EOS.dc.html
// §new-task.
export function NewTaskHero({ project }) {
  return (
    <div className="nt-hero">
      <span className="nt-hero__glyph" aria-hidden="true">
        <svg width="46" height="46" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
          <rect x="1.5" y="2.5" width="13" height="11" rx="3.4" />
          <path d="M4.8 6.2l2 1.8-2 1.8" />
          <line x1="8.4" y1="10" x2="11.2" y2="10" />
        </svg>
      </span>
      <h1 className="nt-hero__title">
        {project
          ? <>What should we build in <span className="nt-hero__project">{project}</span>?</>
          : <>What should we build?</>}
      </h1>
    </div>
  );
}
