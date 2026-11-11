
    UPDATE workers SET permission_mode = 'acceptEdits'
    WHERE permission_mode IN ('default','plan')
  