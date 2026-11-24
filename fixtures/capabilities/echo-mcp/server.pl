#!/usr/bin/perl
# An MCP server over stdio that answers `echo` with its arguments and what it
# was given to work with; `fail` answers with an error, `crash` ends the
# server and `hang` never answers.
use strict;
use warnings;
use JSON::PP;

$| = 1;
my $json = JSON::PP->new->canonical;
my %tools = (
    echo  => "Answer the input back.",
    fail  => "Answer with an error.",
    crash => "End the server.",
    hang  => "Never answer.",
);

sub answer {
    my ($id, $result) = @_;
    print $json->encode({ jsonrpc => "2.0", id => $id, result => $result }), "\n";
}

while (my $line = <STDIN>) {
    my $message = eval { $json->decode($line) } or next;
    next unless defined $message->{id};
    my ($id, $method, $params) = ($message->{id}, $message->{method} // "", $message->{params} // {});
    if ($method eq "initialize") {
        answer($id, {
            protocolVersion => $params->{protocolVersion},
            capabilities    => { tools => {} },
            serverInfo      => { name => "echo-mcp", version => "1.0.0" },
        });
    } elsif ($method eq "tools/list") {
        my @listed = map { { name => $_, description => $tools{$_}, inputSchema => { type => "object" } } } sort keys %tools;
        answer($id, { tools => \@listed });
    } elsif ($method eq "tools/call") {
        my $name = $params->{name} // "";
        exit 4 if $name eq "crash";
        sleep 3600 if $name eq "hang";
        if ($name eq "fail") {
            answer($id, { content => [{ type => "text", text => "it broke" }], isError => JSON::PP::true });
            next;
        }
        my $echoed = {
            input => $params->{arguments} // {},
            token => (($ENV{ECHO_TOKEN} // "") ne "" ? "yes" : "no"),
            vars  => join(" ", sort keys %ENV),
            pid   => $$,
        };
        answer($id, { content => [{ type => "text", text => $json->encode($echoed) }], structuredContent => $echoed });
    } else {
        print $json->encode({ jsonrpc => "2.0", id => $id, error => { code => -32601, message => "no such method" } }), "\n";
    }
}
